from __future__ import annotations

from typing import Any

import pytest

from backend.infra.store.providers.firestore import FirestoreStore
from backend.infra.store.shared import StoreUnavailable


class _Snapshot:
    def __init__(self, doc_id: str, data: dict[str, Any] | None) -> None:
        self.id = doc_id
        self._data = data
        self.exists = data is not None

    def to_dict(self) -> dict[str, Any] | None:
        return dict(self._data) if self._data is not None else None


class _Doc:
    def __init__(self, db: "_FakeFirestore", collection: str, doc_id: str) -> None:
        self._db, self._collection, self.id = db, collection, doc_id

    def get(self, transaction: Any = None) -> _Snapshot:
        self._db.check()
        return _Snapshot(self.id, self._db.data.get(self._collection, {}).get(self.id))

    def set(self, data: dict[str, Any]) -> None:
        self._db.check()
        self._db.data.setdefault(self._collection, {})[self.id] = dict(data)

    def delete(self) -> None:
        self._db.check()
        self._db.data.get(self._collection, {}).pop(self.id, None)


class _Query:
    def __init__(self, db: "_FakeFirestore", collection: str, predicate: Any = None, start: str = "", end: str = "") -> None:
        self._db, self._collection, self._predicate, self._start, self._end = db, collection, predicate, start, end

    def document(self, doc_id: str) -> _Doc:
        return _Doc(self._db, self._collection, doc_id)

    def order_by(self, _field: str) -> "_Query":
        return self

    def start_at(self, cursor: dict[str, _Doc]) -> "_Query":
        return _Query(self._db, self._collection, self._predicate, cursor["__name__"].id, self._end)

    def end_before(self, cursor: dict[str, _Doc]) -> "_Query":
        return _Query(self._db, self._collection, self._predicate, self._start, cursor["__name__"].id)

    def where(self, *, filter: Any) -> "_Query":
        field, value = filter.field_path, filter.value
        return _Query(self._db, self._collection, lambda data: data.get(field) == value, self._start, self._end)

    def stream(self) -> list[_Snapshot]:
        self._db.check()
        rows = sorted(self._db.data.get(self._collection, {}).items())
        return [
            _Snapshot(doc_id, data)
            for doc_id, data in rows
            if (not self._start or doc_id >= self._start)
            and (not self._end or doc_id < self._end)
            and (self._predicate is None or self._predicate(data))
        ]


class _FakeFirestore:
    def __init__(self) -> None:
        self.data: dict[str, dict[str, dict[str, Any]]] = {}
        self.down = False

    def check(self) -> None:
        if self.down:
            raise RuntimeError("DeadlineExceeded")

    def collection(self, name: str) -> _Query:
        return _Query(self, name)


def test_firestore_store_read_write_list_query() -> None:
    db = _FakeFirestore()
    store = FirestoreStore(db)
    store.set_document("chat_sessions", "usr_a:s1", {"user_id_hash": "usr_a", "title": "one"})
    store.set_document("chat_sessions", "usr_a:s2", {"user_id_hash": "usr_a", "title": "two"})
    store.set_document("chat_sessions", "usr_b:s1", {"user_id_hash": "usr_b", "title": "other"})

    assert store.get_document("chat_sessions", "usr_a:s1") == {"user_id_hash": "usr_a", "title": "one"}
    assert [doc_id for doc_id, _ in store.iter_documents("chat_sessions", "usr_a:")] == ["usr_a:s1", "usr_a:s2"]
    assert [doc_id for doc_id, _ in store.query_documents("chat_sessions", "user_id_hash", "usr_b")] == ["usr_b:s1"]
    assert store.delete_document("chat_sessions", "usr_a:s1") is True
    assert store.get_document("chat_sessions", "usr_a:s1") is None


def test_firestore_serves_cached_reads_but_refuses_writes_while_down() -> None:
    db = _FakeFirestore()
    store = FirestoreStore(db)
    store.set_document("user_profiles", "usr_a", {"name": "A"})
    db.down = True

    assert store.get_document("user_profiles", "usr_a") == {"name": "A"}
    with pytest.raises(StoreUnavailable):
        store.get_document("user_profiles", "never_cached")
    with pytest.raises(StoreUnavailable):
        store.set_document("user_profiles", "usr_a", {"name": "B"})
    assert store.durable is False


def test_firestore_deleted_document_is_not_resurrected_from_cache() -> None:
    db = _FakeFirestore()
    store = FirestoreStore(db)
    store.set_document("user_profiles", "usr_a", {"name": "A"})
    db.data["user_profiles"].pop("usr_a")  # deleted by another instance
    assert store.get_document("user_profiles", "usr_a") is None


def test_firestore_health_reports_degraded_when_unreachable() -> None:
    db = _FakeFirestore()
    db.down = True
    assert FirestoreStore(db).schema_health()["status"] == "degraded"
