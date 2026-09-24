from __future__ import annotations

import fnmatch
from typing import Any

import pytest

from backend.domain.memory.graph import MemoryAtom, MemoryGraphService
from backend.infra.store.providers import supabase as supabase_module
from backend.infra.store.providers.supabase import StoreUnavailable, SupabaseStore


class _Response:
    def __init__(self, payload: Any, status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self) -> Any:
        return self._payload


def _like(pattern: str, value: str) -> bool:
    """PostgREST `like` with `*` wildcards and backslash escapes."""
    glob, i = "", 0
    while i < len(pattern):
        char = pattern[i]
        if char == "\\" and i + 1 < len(pattern):
            glob += "[" + pattern[i + 1] + "]"
            i += 2
            continue
        glob += "*" if char in "*%" else ("?" if char == "_" else ("[" + char + "]" if char in "[]?" else char))
        i += 1
    return fnmatch.fnmatchcase(value, glob)


class _PostgREST:
    """In-memory stand-in for the mindpal_documents table and its update RPC."""

    def __init__(self) -> None:
        self.rows: dict[tuple[str, str], dict[str, Any]] = {}
        self.calls = 0

    def request(self, method: str, path: str, **kwargs: Any) -> _Response:
        self.calls += 1
        params = kwargs.get("params") or {}
        if path.endswith("/mindpal_documents") and method == "GET":
            matched = []
            for (collection, doc_id), row in sorted(self.rows.items(), key=lambda item: item[0][1]):
                if "collection" in params and collection != params["collection"][3:]:
                    continue
                doc_filter = params.get("doc_id", "")
                if doc_filter.startswith("eq.") and doc_id != doc_filter[3:]:
                    continue
                if doc_filter.startswith("like.") and not _like(doc_filter[5:], doc_id):
                    continue
                field_filters = {k[len("data->>"):]: v[3:] for k, v in params.items() if k.startswith("data->>")}
                if any(str(row["data"].get(field)) != value for field, value in field_filters.items()):
                    continue
                matched.append({"doc_id": doc_id, **row})
            offset = int(params.get("offset", 0))
            limit = int(params.get("limit", 1000))
            return _Response(matched[offset : offset + min(limit, 1000)])
        if path.endswith("/mindpal_documents") and method == "DELETE":
            self.rows.pop((params["collection"][3:], params["doc_id"][3:]), None)
            return _Response([])
        if "/rpc/mindpal_update_document" in path:
            payload = kwargs["json"]
            if not payload["p_collection"] or not payload["p_doc_id"]:
                return _Response({"message": "invalid_document_payload"}, status_code=400)
            key = (payload["p_collection"], payload["p_doc_id"])
            current = self.rows.get(key)
            expected = payload["p_expected_revision"]
            if current is None:
                if expected > 0:
                    return _Response({"ok": False, "revision": 0})
                self.rows[key] = {"data": payload["p_next_data"], "revision": 1}
                return _Response({"ok": True, "revision": 1})
            if current["revision"] != expected:
                return _Response({"ok": False, "revision": current["revision"]})
            self.rows[key] = {"data": payload["p_next_data"], "revision": current["revision"] + 1}
            return _Response({"ok": True, "revision": current["revision"] + 1})
        raise AssertionError(f"unexpected request: {method} {path}")


def _store(client: Any | None = None) -> SupabaseStore:
    return SupabaseStore("https://example.supabase.co", "service-key", client=client or _PostgREST())  # type: ignore[arg-type]


def test_supabase_store_preserves_document_store_contract() -> None:
    store = _store()
    store.set_document("profiles", "usr_one", {"name": "One"})
    assert store.get_document("profiles", "usr_one") == {"name": "One"}
    assert store.list_documents("profiles", "usr_") == [{"name": "One"}]

    result = store.transact(
        "profiles",
        "usr_one",
        lambda current, write: (write({"name": current["name"], "seen": True}), "done")[1],
    )
    assert result == "done"
    assert store.get_document("profiles", "usr_one") == {"name": "One", "seen": True}

    # Replace semantics: a removed key really disappears.
    store.set_document("profiles", "usr_one", {"name": "One"})
    assert store.get_document("profiles", "usr_one") == {"name": "One"}

    assert store.delete_document("profiles", "usr_one") is True
    assert store.get_document("profiles", "usr_one") is None


def test_listing_pages_past_the_postgrest_row_cap(monkeypatch) -> None:
    monkeypatch.setattr(supabase_module, "PAGE_SIZE", 7)
    store = _store()
    for index in range(30):
        store.set_document("voice_telemetry", f"usr_a:{index:03d}", {"n": index, "user_id_hash": "usr_a"})
    ids = [doc_id for doc_id, _ in store.iter_documents("voice_telemetry")]
    assert ids == [f"usr_a:{index:03d}" for index in range(30)]
    assert len(store.query_documents("voice_telemetry", "user_id_hash", "usr_a")) == 30


def test_prefix_underscore_is_not_a_wildcard() -> None:
    store = _store()
    store.set_document("chat_sessions", "ab_1:s", {"owner": "ab_1"})
    store.set_document("chat_sessions", "abX1:s", {"owner": "abX1"})
    assert store.list_documents("chat_sessions", "ab_1:") == [{"owner": "ab_1"}]


def test_query_documents_only_returns_that_owner() -> None:
    store = _store()
    store.set_document("voice_sessions", "vs_1", {"user_id_hash": "usr_a"})
    store.set_document("voice_sessions", "vs_2", {"user_id_hash": "usr_b"})
    assert store.query_documents("voice_sessions", "user_id_hash", "usr_a") == [("vs_1", {"user_id_hash": "usr_a"})]


def test_stale_write_does_not_resurrect_a_deleted_document() -> None:
    client = _PostgREST()
    store = _store(client)
    store.set_document("profiles", "usr_one", {"v": 1})
    client.rows.pop(("profiles", "usr_one"))  # deleted after a writer read revision 1

    assert store._update("profiles", "usr_one", 1, {"v": 2}) is False
    assert ("profiles", "usr_one") not in client.rows  # no phantom '{}' row


def test_memory_graph_uses_supabase_document_store() -> None:
    client = _PostgREST()
    store = _store(client)
    memory = MemoryGraphService(store=store)
    graph, saved = memory.merge_atoms("usr_one", [MemoryAtom(id="name", category="profile", value="Preferred name: One")])
    assert [atom.id for atom in saved] == ["name"]
    assert client.rows[("memory_graphs", "usr_one")]["data"]["atoms"][0]["id"] == "name"
    assert memory.get_memory_graph("usr_one").atoms[0].value == "Preferred name: One"


def test_construction_never_crashes_when_supabase_is_down() -> None:
    class _Down:
        def request(self, method: str, path: str, **kwargs: Any) -> _Response:
            raise RuntimeError("network unavailable")

    store = _store(_Down())
    assert store.schema_health()["status"] == "degraded"
    with pytest.raises(StoreUnavailable):
        store.get_document("profiles", "usr_one")


def test_reads_are_served_from_cache_during_an_outage_but_writes_fail_closed() -> None:
    client = _PostgREST()
    store = _store(client)
    store.set_document("profiles", "usr_one", {"name": "One"})
    store.set_document("greeting_cache", "usr_one:day", {"greeting": "Hi"})
    assert store.get_document("profiles", "usr_one") == {"name": "One"}

    def down(method: str, path: str, **kwargs: Any) -> _Response:
        raise RuntimeError("network unavailable")

    client.request = down  # type: ignore[method-assign]
    assert store.get_document("greeting_cache", "usr_one:day") == {"greeting": "Hi"}
    # A profile, session or memory copy may be stale after another instance
    # changed or deleted it: it fails closed (audit MP-08).
    with pytest.raises(StoreUnavailable):
        store.get_document("profiles", "usr_one")
    with pytest.raises(StoreUnavailable):
        store.get_document("greeting_cache", "never_cached")
    with pytest.raises(StoreUnavailable):
        store.set_document("profiles", "usr_one", {"name": "Two"})
    assert store.durable is False


@pytest.mark.parametrize(
    ("env", "expected"),
    [
        ({"MINDPAL_STORAGE_PROVIDER": "memory"}, "memory"),
        ({"MINDPAL_STORAGE_PROVIDER": "firestore"}, "firestore"),
        ({"MINDPAL_STORAGE_PROVIDER": "supabase", "SUPABASE_URL": "https://x.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": "k"}, "supabase"),
        ({"FIREBASE_CREDENTIALS_JSON": "{}"}, "firestore"),
        # Both configured: Supabase is the production store.
        ({"FIREBASE_CREDENTIALS_JSON": "{}", "SUPABASE_URL": "https://x.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": "k"}, "supabase"),
        ({"SUPABASE_URL": "https://x.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": "k"}, "supabase"),
        ({}, "memory"),
    ],
)
def test_storage_provider_selection(monkeypatch, env: dict[str, str], expected: str) -> None:
    from backend.configs.settings import get_settings

    for name in ("MINDPAL_STORAGE_PROVIDER", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "FIREBASE_CREDENTIALS_JSON",
                 "FIREBASE_CREDENTIALS_BASE64", "FIREBASE_CREDENTIALS_PATH", "GOOGLE_APPLICATION_CREDENTIALS"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("ENABLE_FIREBASE", "true")
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    assert get_settings().configured_storage_provider() == expected


def test_firebase_credentials_are_ignored_when_firebase_is_disabled(monkeypatch) -> None:
    from backend.configs.settings import get_settings

    monkeypatch.delenv("MINDPAL_STORAGE_PROVIDER", raising=False)
    monkeypatch.setenv("ENABLE_FIREBASE", "false")
    monkeypatch.setenv("FIREBASE_CREDENTIALS_JSON", "{}")
    assert get_settings().configured_storage_provider() != "firestore"


def test_unknown_provider_is_refused(monkeypatch) -> None:
    from backend.infra.store.store import build_store

    monkeypatch.setenv("MINDPAL_STORAGE_PROVIDER", "mongodb")
    with pytest.raises(RuntimeError, match="Unsupported MINDPAL_STORAGE_PROVIDER"):
        build_store()


def test_firestore_is_a_supported_provider_again(monkeypatch) -> None:
    from backend.infra.store.providers.firestore import FirestoreStore
    from backend.infra.store.store import build_store

    monkeypatch.setenv("MINDPAL_STORAGE_PROVIDER", "firestore")
    monkeypatch.setenv("ENABLE_FIREBASE", "true")
    assert isinstance(build_store(), FirestoreStore)
