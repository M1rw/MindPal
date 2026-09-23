# tests/backend/storage/test_store_and_quota_integrity.py
#
# Two failures that compounded into one: a single Firestore exception latched the
# store into per-process memory for the life of the process, and quota reserves
# were a read-check-write. Together, anyone who could make one storage call fail
# got a service with no limits at all — and nothing said so.

from __future__ import annotations

import threading
import time
from typing import Any, Dict, Optional

import pytest

from backend.domain.quota.quota import (
    ANON_RATE_COLLECTION,
    USER_QUOTA_COLLECTION,
    QuotaService,
    anonymous_quota_key,
)
from backend.infra.store.store import (
    BREAKER_COOLDOWN_SECONDS,
    FirestoreStore,
    InMemoryStore,
    StoreUnavailable,
    is_permanent_store_error,
    store_is_durable,
)


# --- fakes -------------------------------------------------------------------


class _Snapshot:
    def __init__(self, data: Optional[Dict[str, Any]]) -> None:
        self._data = data

    @property
    def exists(self) -> bool:
        return self._data is not None

    def to_dict(self) -> Dict[str, Any]:
        return dict(self._data or {})


class _FakeDoc:
    def __init__(self, db: "_FakeDb", collection: str, doc_id: str) -> None:
        self._db, self._c, self._id = db, collection, doc_id

    def get(self, transaction: Any = None) -> _Snapshot:
        self._db.check("get")
        return _Snapshot(self._db.data.get(self._c, {}).get(self._id))

    def set(self, data: Dict[str, Any], merge: bool = False) -> None:
        self._db.check("set")
        self._db.data.setdefault(self._c, {})[self._id] = dict(data)

    def delete(self) -> None:
        self._db.check("delete")
        self._db.data.get(self._c, {}).pop(self._id, None)


class _FakeCollection:
    def __init__(self, db: "_FakeDb", name: str) -> None:
        self._db, self._name = db, name

    def document(self, doc_id: str) -> _FakeDoc:
        return _FakeDoc(self._db, self._name, doc_id)

    def stream(self):
        self._db.check("stream")
        return [_Snapshot(v) for v in self._db.data.get(self._name, {}).values()]


class _FakeDb:
    """A Firestore stand-in whose failure can be switched on and off."""

    def __init__(self) -> None:
        self.data: Dict[str, Dict[str, Dict[str, Any]]] = {}
        self.failing: Optional[Exception] = None
        self.calls = 0

    def collection(self, name: str) -> _FakeCollection:
        return _FakeCollection(self, name)

    def check(self, _op: str) -> None:
        self.calls += 1
        if self.failing is not None:
            raise self.failing


class _Unavailable(Exception):
    """Transient, the kind worth retrying."""


class NotFound(Exception):
    """A configuration fault.

    Named exactly as google.api_core.exceptions.NotFound is: the classifier
    matches on the class name, because the concrete exception type differs
    between the gRPC and REST Firestore transports.
    """


# --- store resilience --------------------------------------------------------


def test_one_transient_failure_does_not_latch_the_store_off() -> None:
    db = _FakeDb()
    store = FirestoreStore(db)
    store.set_document("c", "d", {"v": 1})
    assert store.durable is True

    db.failing = _Unavailable("blip")
    with pytest.raises(StoreUnavailable):
        store.set_document("c", "d", {"v": 2})

    # The blip passes; the store must come back on its own rather than spending
    # the rest of the process serving per-instance memory.
    db.failing = None
    store.set_document("c", "d", {"v": 3})
    assert store.durable is True
    assert db.data["c"]["d"] == {"v": 3}


def test_breaker_opens_after_repeated_failures_and_recovers_after_cooldown(monkeypatch) -> None:
    db = _FakeDb()
    store = FirestoreStore(db)
    db.failing = _Unavailable("down")
    for _ in range(3):
        with pytest.raises(StoreUnavailable):
            store.set_document("c", "d", {"v": 1})
    assert store.durable is False

    clock = time.monotonic() + BREAKER_COOLDOWN_SECONDS + 1
    monkeypatch.setattr(time, "monotonic", lambda: clock)
    assert store.durable is True, "breaker must half-open and probe again"


def test_a_configuration_fault_opens_the_breaker_immediately() -> None:
    """A database that does not exist will not start existing on retry #3."""
    assert is_permanent_store_error(NotFound("no such database")) is True
    assert is_permanent_store_error(_Unavailable("blip")) is False

    db = _FakeDb()
    store = FirestoreStore(db)
    db.failing = NotFound("no such database")
    calls_before = db.calls
    with pytest.raises(StoreUnavailable):
        store.set_document("c", "d", {"v": 1})
    assert db.calls - calls_before == 1, "a permanent fault must not be retried"
    assert store.durable is False


def test_a_deleted_document_does_not_come_back_from_cache() -> None:
    db = _FakeDb()
    store = FirestoreStore(db)
    store.set_document("c", "d", {"v": 1})
    assert store.get_document("c", "d") == {"v": 1}
    store.delete_document("c", "d")
    assert store.get_document("c", "d") is None


def test_in_memory_store_reports_itself_as_not_durable() -> None:
    assert store_is_durable(InMemoryStore()) is False


def test_in_memory_cache_is_bounded() -> None:
    store = InMemoryStore(max_docs_per_collection=10)
    for index in range(50):
        store.set_document("c", f"d{index}", {"i": index})
    assert len(store.list_documents("c")) == 10


# --- quota atomicity ---------------------------------------------------------


_LATENCY_S = 0.02


class _NetworkStore(InMemoryStore):
    """Models a remote store: a read is a round trip, and so is a write.

    The gap between the two is the entire race. A plain in-process get/set pair
    cannot show it — the GIL never schedules another thread between them — so a
    concurrency test against a bare InMemoryStore passes whether the code is
    atomic or not. Latency here is what makes the test able to fail.
    """

    def get_document(self, collection: str, doc_id: str):
        time.sleep(_LATENCY_S)
        return super().get_document(collection, doc_id)

    def set_document(self, collection: str, doc_id: str, data: Dict[str, Any]) -> None:
        time.sleep(_LATENCY_S)
        super().set_document(collection, doc_id, data)

    def transact(self, collection: str, doc_id: str, mutate):
        with self._lock:
            time.sleep(_LATENCY_S)
            current = self._collections.get(collection, {}).get(doc_id)
            return mutate(
                dict(current) if current is not None else None,
                lambda data: InMemoryStore.set_document(self, collection, doc_id, data),
            )


def _race_reserves(quota: QuotaService, *, threads: int) -> int:
    granted: list[bool] = []
    barrier = threading.Barrier(threads)
    lock = threading.Lock()

    def attempt() -> None:
        barrier.wait()
        decision = quota.reserve("usr_racer", 1)
        with lock:
            granted.append(decision.allowed)

    workers = [threading.Thread(target=attempt) for _ in range(threads)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join()
    return sum(granted)


class _LegacyReadCheckWriteQuota(QuotaService):
    """The pre-fix reserve, kept so the test can prove it fails."""

    def _reserve(self, collection: str, subject: str, cost: int, *, anonymous: bool):
        now = self._now()
        limit_5h, limit_week = self._limits(anonymous=anonymous)
        doc = self._load(collection, subject, now)
        used_5h = int(doc.get("total_credits_5h") or 0)
        if used_5h + cost > limit_5h:
            return self._decision(
                doc, cost=cost, allowed=False, now=now,
                limit_5h=limit_5h, limit_week=limit_week, scope="account",
            )
        doc["total_credits_5h"] = used_5h + cost
        doc["total_credits_week"] = int(doc.get("total_credits_week") or 0) + cost
        self.store.set_document(collection, subject, doc)
        return self._decision(
            doc, cost=cost, allowed=True, now=now,
            limit_5h=limit_5h, limit_week=limit_week, scope="account",
        )



def test_reserve_is_atomic_under_concurrency() -> None:
    """Twenty callers racing a limit of five get exactly five grants."""
    store = _NetworkStore()
    quota = QuotaService(store, limit_5h=5, limit_week=5)
    assert _race_reserves(quota, threads=20) == 5
    assert store.get_document(USER_QUOTA_COLLECTION, "usr_racer")["total_credits_5h"] == 5


def test_reserve_goes_through_a_single_store_transaction() -> None:
    """The atomicity guarantee is the transaction, so assert it is used.

    On Firestore this is the difference between one compare-and-set and two
    independent round trips; nothing in a single-process test can stand in for
    that, so the call itself is what gets checked.
    """
    calls: list[str] = []

    class _Recording(InMemoryStore):
        def set_document(self, collection, doc_id, data):
            calls.append("set")
            super().set_document(collection, doc_id, data)

        def transact(self, collection, doc_id, mutate):
            calls.append("transact")
            return super().transact(collection, doc_id, mutate)

    QuotaService(_Recording(), limit_5h=5, limit_week=5).reserve("usr_txn", 1)
    assert calls.count("transact") == 1
    assert "set" not in calls[: calls.index("transact")]


def test_reserve_denies_when_storage_cannot_settle_it() -> None:
    """Fail closed. Failing open means an outage silently removes every limit."""
    db = _FakeDb()
    store = FirestoreStore(db)
    db.failing = NotFound("database is gone")
    quota = QuotaService(store)
    decision = quota.reserve("usr_nostore", 1)
    assert decision.allowed is False


def test_refund_never_raises_when_storage_is_down() -> None:
    """A refund failure over-charges by one credit; it must not also become a
    second error on a turn that already failed."""
    db = _FakeDb()
    store = FirestoreStore(db)
    db.failing = NotFound("database is gone")
    QuotaService(store).refund_quota("usr_nostore", 1)  # must not raise


def test_anonymous_quota_is_keyed_on_the_network_not_a_shared_identity() -> None:
    store = InMemoryStore()
    quota = QuotaService(store, anon_limit_5h=2, anon_limit_week=2)
    assert quota.reserve_anonymous("203.0.113.9").allowed is True
    assert quota.reserve_anonymous("203.0.113.9").allowed is True
    assert quota.reserve_anonymous("203.0.113.9").allowed is False
    # A different network has its own budget.
    assert quota.reserve_anonymous("198.51.100.4").allowed is True
    assert store.get_document(ANON_RATE_COLLECTION, anonymous_quota_key("203.0.113.9")) is not None


def test_guest_without_an_account_key_is_not_a_user_quota_subject() -> None:
    quota = QuotaService(InMemoryStore())
    assert quota.reserve("", 1).allowed is False
    assert quota.reserve("usr_anon_default", 1).allowed is False






def test_a_degraded_read_is_never_older_than_the_limit() -> None:
    """Audit MP-08: cached copies had no age limit and no cross-instance invalidation."""
    from backend.infra.store.shared import DegradedReadCache

    now = [1000.0]
    cache = DegradedReadCache(max_age_s=300.0, clock=lambda: now[0])
    cache.remember("greeting_cache", "k", {"greeting": "Hi"})
    cache.remember("voice_sessions", "vs_1", {"status": "warm"})
    assert cache.recall("greeting_cache", "k") == {"greeting": "Hi"}
    assert cache.recall("voice_sessions", "vs_1") is None, "session state is never served stale"
    now[0] += 301
    assert cache.recall("greeting_cache", "k") is None
