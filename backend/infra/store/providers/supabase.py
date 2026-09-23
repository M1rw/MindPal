from __future__ import annotations

import logging
from typing import Any, Dict, Iterator, List, Optional, Tuple

import httpx

from backend.infra.store.providers.memory import InMemoryStore
from backend.infra.store.shared import (
    BREAKER_COOLDOWN_SECONDS,
    BREAKER_FAILURE_THRESHOLD,
    CACHE_MAX_DOCS_PER_COLLECTION,
    CloudBreaker,
    Mutator,
    StoreUnavailable,
    with_retry,
)

logger = logging.getLogger("mindpal.store.supabase")

SUPABASE_DOCUMENTS_TABLE = "mindpal_documents"
SUPABASE_TRANSACTION_RPC = "mindpal_update_document"
TRANSACTION_ATTEMPTS = 5
# PostgREST caps a response (1000 rows by default). Every listing pages through
# with an explicit order so a per-user delete or export is never silently cut.
PAGE_SIZE = 500
_TABLE_PATH = f"/rest/v1/{SUPABASE_DOCUMENTS_TABLE}"


def _like_prefix(prefix: str) -> str:
    """Escape LIKE wildcards: `_` in a doc-id prefix must not match any character."""
    escaped = prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"like.{escaped}*"


class SupabaseStore:
    """DocumentStore adapter over Supabase PostgREST.

    Firebase Auth remains the identity system. This adapter only stores the
    already-derived MindPal document keys and never accepts client identity.
    """

    provider_name = "supabase"

    def __init__(self, url: str, service_role_key: str, *, client: httpx.Client | None = None, timeout: float = 10.0) -> None:
        clean_url = url.rstrip("/")
        clean_key = service_role_key.strip()
        if not clean_url or not clean_key:
            raise ValueError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")
        self._client = client or httpx.Client(
            base_url=clean_url,
            timeout=timeout,
            headers={
                "apikey": clean_key,
                "Authorization": f"Bearer {clean_key}",
                "Content-Type": "application/json",
            },
        )
        # Read-through cache: serves reads only while the breaker is open.
        self._cache = InMemoryStore(max_docs_per_collection=CACHE_MAX_DOCS_PER_COLLECTION)
        self._breaker = CloudBreaker(threshold=BREAKER_FAILURE_THRESHOLD, cooldown=BREAKER_COOLDOWN_SECONDS)

    # -- health -------------------------------------------------------------

    def _probe_table_access(self) -> None:
        self._request("GET", _TABLE_PATH, params={"select": "doc_id", "limit": "1"})

    def _probe_transaction_rpc(self) -> None:
        """A deliberately invalid payload must be refused by the function itself.

        400/422 proves the RPC exists without creating or changing a document;
        404 means the migration is missing.
        """
        try:
            response = self._client.request(
                "POST",
                f"/rest/v1/rpc/{SUPABASE_TRANSACTION_RPC}",
                json={"p_collection": "", "p_doc_id": "", "p_expected_revision": 0, "p_next_data": {}},
            )
        except Exception as exc:
            raise StoreUnavailable("Supabase transaction RPC probe failed") from exc
        if int(getattr(response, "status_code", 0) or 0) not in {400, 422}:
            raise StoreUnavailable(f"Supabase RPC {SUPABASE_TRANSACTION_RPC!r} is unavailable; verify the migration")

    def schema_health(self) -> dict[str, Any]:
        try:
            self._probe_table_access()
            table_ok = True
        except StoreUnavailable:
            table_ok = False
        try:
            self._probe_transaction_rpc()
            rpc_ok = True
        except StoreUnavailable:
            rpc_ok = False
        return {
            "provider": "supabase",
            "table_ok": table_ok,
            "transaction_rpc_ok": rpc_ok,
            "status": "ok" if table_ok and rpc_ok else "degraded",
        }

    @property
    def durable(self) -> bool:
        return self._breaker.closed

    # -- transport ----------------------------------------------------------

    def _request(self, method: str, path: str, *, retry: bool = False, **kwargs: Any) -> httpx.Response:
        if not self._breaker.closed:
            raise StoreUnavailable("Supabase storage circuit is open")

        def send() -> httpx.Response:
            response = self._client.request(method, path, **kwargs)
            response.raise_for_status()
            return response

        try:
            response = with_retry(f"{method} {path}", send) if retry else send()
        except Exception as exc:
            self._breaker.record_failure()
            logger.error("supabase_store_request_failed method=%s path=%s error=%s", method, path, type(exc).__name__)
            raise StoreUnavailable(f"Supabase storage request failed for {method} {path}") from exc
        self._breaker.record_success()
        return response

    @staticmethod
    def _json(response: httpx.Response) -> Any:
        try:
            return response.json()
        except ValueError as exc:
            raise StoreUnavailable("Supabase storage returned invalid JSON") from exc

    @classmethod
    def _rows(cls, response: httpx.Response) -> list[dict[str, Any]]:
        payload = cls._json(response)
        if not isinstance(payload, list):
            raise StoreUnavailable("Supabase storage returned an invalid row list")
        return [row for row in payload if isinstance(row, dict)]

    def _get_row(self, collection: str, doc_id: str) -> dict[str, Any] | None:
        response = self._request(
            "GET",
            _TABLE_PATH,
            retry=True,
            params={"collection": f"eq.{collection}", "doc_id": f"eq.{doc_id}", "select": "data,revision", "limit": "1"},
        )
        rows = self._rows(response)
        return rows[0] if rows else None

    def _paged(self, params: Dict[str, str]) -> Iterator[dict[str, Any]]:
        offset = 0
        while True:
            page = self._rows(
                self._request(
                    "GET",
                    _TABLE_PATH,
                    retry=True,
                    params={**params, "order": "doc_id.asc", "limit": str(PAGE_SIZE), "offset": str(offset)},
                )
            )
            yield from page
            if len(page) < PAGE_SIZE:
                return
            offset += PAGE_SIZE

    def _update(self, collection: str, doc_id: str, expected_revision: int, data: Dict[str, Any]) -> bool:
        response = self._request(
            "POST",
            f"/rest/v1/rpc/{SUPABASE_TRANSACTION_RPC}",
            json={"p_collection": collection, "p_doc_id": doc_id, "p_expected_revision": expected_revision, "p_next_data": data},
        )
        payload = self._json(response)
        return isinstance(payload, dict) and payload.get("ok") is True

    # -- DocumentStore ------------------------------------------------------

    def get_document(self, collection: str, doc_id: str) -> Optional[Dict[str, Any]]:
        try:
            row = self._get_row(collection, doc_id)
        except StoreUnavailable:
            cached = self._cache.get_document(collection, doc_id)
            if cached is not None:
                logger.warning("supabase_get_served_from_cache collection=%s", collection)
                return cached
            raise
        if not row or not isinstance(row.get("data"), dict):
            self._cache.delete_document(collection, doc_id)
            return None
        data = dict(row["data"])
        self._cache.set_document(collection, doc_id, data)
        return data

    def set_document(self, collection: str, doc_id: str, data: Dict[str, Any]) -> None:
        payload = dict(data)
        for _ in range(TRANSACTION_ATTEMPTS):
            row = self._get_row(collection, doc_id)
            if self._update(collection, doc_id, int(row.get("revision", 0)) if row else 0, payload):
                self._cache.set_document(collection, doc_id, payload)
                return
        raise StoreUnavailable(f"Supabase write conflicted for {collection}")

    def delete_document(self, collection: str, doc_id: str) -> bool:
        self._request(
            "DELETE",
            _TABLE_PATH,
            params={"collection": f"eq.{collection}", "doc_id": f"eq.{doc_id}"},
            headers={"Prefer": "return=minimal"},
        )
        self._cache.delete_document(collection, doc_id)
        return True

    def iter_documents(self, collection: str, prefix: str = "") -> Iterator[Tuple[str, Dict[str, Any]]]:
        params = {"collection": f"eq.{collection}", "select": "doc_id,data"}
        if prefix:
            params["doc_id"] = _like_prefix(prefix)
        for row in self._paged(params):
            if isinstance(row.get("data"), dict):
                yield str(row.get("doc_id") or ""), dict(row["data"])

    def list_documents(self, collection: str, prefix: str = "") -> List[Dict[str, Any]]:
        return [data for _doc_id, data in self.iter_documents(collection, prefix)]

    def query_documents(self, collection: str, field: str, value: Any) -> List[Tuple[str, Dict[str, Any]]]:
        params = {"collection": f"eq.{collection}", "select": "doc_id,data", f"data->>{field}": f"eq.{value}"}
        return [
            (str(row.get("doc_id") or ""), dict(row["data"]))
            for row in self._paged(params)
            if isinstance(row.get("data"), dict) and row["data"].get(field) == value
        ]

    def transact(self, collection: str, doc_id: str, mutate: Mutator[Any]) -> Any:
        for _ in range(TRANSACTION_ATTEMPTS):
            row = self._get_row(collection, doc_id)
            current = row.get("data") if row and isinstance(row.get("data"), dict) else None
            expected_revision = int(row.get("revision", 0)) if row else 0
            next_data: dict[str, Any] | None = None

            def write(data: Dict[str, Any]) -> None:
                nonlocal next_data
                next_data = dict(data)

            result = mutate(dict(current) if current is not None else None, write)
            if next_data is None:
                return result
            if self._update(collection, doc_id, expected_revision, next_data):
                self._cache.set_document(collection, doc_id, next_data)
                return result
        raise StoreUnavailable(f"Supabase transaction conflicted for {collection}")


__all__ = ["SupabaseStore", "SUPABASE_DOCUMENTS_TABLE", "SUPABASE_TRANSACTION_RPC"]
