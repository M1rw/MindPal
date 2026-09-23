"""Cloud Firestore document store.

Restored as a first-class provider with the lessons of both earlier stores:

* A half-open circuit breaker instead of a one-way downgrade. A timeout at
  cold start never turns the instance into per-process memory.
* Reads may be served from a bounded cache while the cloud is degraded (a stale
  read beats an outage). Writes never pretend to be durable: they raise
  `StoreUnavailable`, so limit enforcement (credits, voice minutes) fails closed.
* Writes replace the document, matching the Supabase and memory providers, so a
  removed key really disappears regardless of which provider is active.
* Field queries (`query_documents`) and id-aware iteration (`iter_documents`)
  so per-user scans never read other users' rows and migrations keep ids.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Iterator, List, Optional, Tuple

from backend.configs.settings import get_settings
from backend.infra.store.providers.memory import InMemoryStore
from backend.infra.store.shared import (
    BREAKER_COOLDOWN_SECONDS,
    BREAKER_FAILURE_THRESHOLD,
    CACHE_MAX_DOCS_PER_COLLECTION,
    CloudBreaker,
    Mutator,
    StoreUnavailable,
    is_permanent_store_error,
    with_retry,
)

logger = logging.getLogger("mindpal.store.firestore")

_PROBE_COLLECTION = "_mindpal_health"
_PROBE_DOCUMENT = "probe"


def firestore_client() -> Any:
    """Build a client from the shared Firebase Admin app, or raise StoreUnavailable."""
    from backend.infra.firebase.app import firebase_init_error, get_firebase_app

    app = get_firebase_app()
    if app is None:
        raise StoreUnavailable(f"Firebase Admin is not initialized ({firebase_init_error() or 'disabled'})")
    from firebase_admin import firestore

    database_id = get_settings().firestore_database_id.strip() or "(default)"
    if database_id in {"(default)", "default"}:
        return firestore.client(app=app)
    return firestore.client(app=app, database_id=database_id)


class FirestoreStore:
    provider_name = "firestore"

    def __init__(self, db: Any = None) -> None:
        self._db = db
        self._cache = InMemoryStore(max_docs_per_collection=CACHE_MAX_DOCS_PER_COLLECTION)
        self._breaker = CloudBreaker(threshold=BREAKER_FAILURE_THRESHOLD, cooldown=BREAKER_COOLDOWN_SECONDS)

    # -- plumbing -----------------------------------------------------------

    @property
    def durable(self) -> bool:
        return self._breaker.closed

    def _client(self) -> Any:
        if self._db is None:
            # Built lazily so a missing credential at import time is a degraded
            # store the breaker can recover from, not a crashed deployment.
            self._db = firestore_client()
        return self._db

    def _call(self, operation: str, call: Any) -> Any:
        if not self._breaker.closed:
            raise StoreUnavailable(f"Firestore circuit is open ({operation})")
        try:
            result = with_retry(operation, call)
        except StoreUnavailable:
            self._breaker.record_failure()
            raise
        except Exception as exc:
            self._breaker.record_failure(permanent=is_permanent_store_error(exc))
            logger.error("firestore_%s_failed error=%s", operation, type(exc).__name__)
            raise StoreUnavailable(f"Firestore {operation} failed") from exc
        self._breaker.record_success()
        return result

    def _collection(self, name: str) -> Any:
        return self._client().collection(name)

    # -- DocumentStore ------------------------------------------------------

    def get_document(self, collection: str, doc_id: str) -> Optional[Dict[str, Any]]:
        try:
            snapshot = self._call("get", lambda: self._collection(collection).document(doc_id).get())
        except StoreUnavailable:
            cached = self._cache.get_document(collection, doc_id)
            if cached is not None:
                logger.warning("firestore_get_served_from_cache collection=%s", collection)
                return cached
            raise
        if not snapshot.exists:
            # Absent in the cloud is absent: a cached copy must not resurrect it.
            self._cache.delete_document(collection, doc_id)
            return None
        data = snapshot.to_dict() or {}
        self._cache.set_document(collection, doc_id, data)
        return dict(data)

    def set_document(self, collection: str, doc_id: str, data: Dict[str, Any]) -> None:
        payload = dict(data)
        self._call("set", lambda: self._collection(collection).document(doc_id).set(payload))
        self._cache.set_document(collection, doc_id, payload)

    def delete_document(self, collection: str, doc_id: str) -> bool:
        self._call("delete", lambda: self._collection(collection).document(doc_id).delete())
        self._cache.delete_document(collection, doc_id)
        return True

    def iter_documents(self, collection: str, prefix: str = "") -> Iterator[Tuple[str, Dict[str, Any]]]:
        def run() -> List[Any]:
            ref = self._collection(collection)
            if prefix:
                end = prefix[:-1] + chr(ord(prefix[-1]) + 1)
                ref = ref.order_by("__name__").start_at({"__name__": ref.document(prefix)}).end_before(
                    {"__name__": ref.document(end)}
                )
            return list(ref.stream())

        for snapshot in self._call("list", run):
            yield snapshot.id, snapshot.to_dict() or {}

    def list_documents(self, collection: str, prefix: str = "") -> List[Dict[str, Any]]:
        return [data for _doc_id, data in self.iter_documents(collection, prefix)]

    def query_documents(self, collection: str, field: str, value: Any) -> List[Tuple[str, Dict[str, Any]]]:
        from google.cloud.firestore_v1.base_query import FieldFilter

        def run() -> List[Any]:
            return list(self._collection(collection).where(filter=FieldFilter(field, "==", value)).stream())

        return [(snapshot.id, snapshot.to_dict() or {}) for snapshot in self._call("query", run)]

    def transact(self, collection: str, doc_id: str, mutate: Mutator[Any]) -> Any:
        """Read-modify-write in a Firestore transaction (retried on contention).

        `mutate` may run more than once, so it must have no side effects outside
        the store.
        """
        from google.cloud import firestore as gcf

        def run() -> Any:
            client = self._client()
            doc_ref = client.collection(collection).document(doc_id)
            written: Dict[str, Any] = {}

            @gcf.transactional
            def body(transaction: Any) -> Any:
                written.clear()
                snapshot = doc_ref.get(transaction=transaction)
                current = snapshot.to_dict() if snapshot.exists else None

                def write(data: Dict[str, Any]) -> None:
                    written["data"] = dict(data)
                    transaction.set(doc_ref, dict(data))

                return mutate(dict(current) if current is not None else None, write)

            result = body(client.transaction())
            if "data" in written:
                self._cache.set_document(collection, doc_id, written["data"])
            return result

        if not self._breaker.closed:
            raise StoreUnavailable(f"Firestore circuit is open (transact {collection})")
        try:
            result = run()
        except Exception as exc:
            if type(exc).__name__ == "AppError":
                raise  # a domain decision inside the mutator, not a storage failure
            self._breaker.record_failure(permanent=is_permanent_store_error(exc))
            logger.error("firestore_transaction_failed collection=%s error=%s", collection, type(exc).__name__)
            raise StoreUnavailable(f"Firestore transaction failed for {collection}") from exc
        self._breaker.record_success()
        return result

    # -- health -------------------------------------------------------------

    def schema_health(self) -> Dict[str, Any]:
        try:
            self._call("probe", lambda: self._collection(_PROBE_COLLECTION).document(_PROBE_DOCUMENT).get())
            reachable = True
        except StoreUnavailable:
            reachable = False
        return {
            "provider": "firestore",
            "database": get_settings().firestore_database_id.strip() or "(default)",
            "reachable": reachable,
            "status": "ok" if reachable else "degraded",
        }


__all__ = ["FirestoreStore", "firestore_client"]
