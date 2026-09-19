# backend/infra/store/store.py — Document Store Gateway with Cloud Firestore Support

from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Protocol, TypeVar

logger = logging.getLogger("mindpal.store")

T = TypeVar("T")

# A Firestore blip must not become a permanent downgrade. The old gateway set a
# single `_cloud_available = False` on the first exception and never tried again
# for the life of the process, so one timeout silently turned a shared database
# into per-instance memory: quota windows reset, chats stopped persisting, and
# nothing surfaced it. This is a real half-open breaker instead.
BREAKER_FAILURE_THRESHOLD = 3
BREAKER_COOLDOWN_SECONDS = 30.0
RETRY_ATTEMPTS = 3
RETRY_BASE_DELAY_SECONDS = 0.05
# The cache is a read-through convenience, not a shadow database. Unbounded, the
# old fallback mirrored every document ever written into process memory.
CACHE_MAX_DOCS_PER_COLLECTION = 2_000


class StoreUnavailable(RuntimeError):
    """Durable storage could not serve this write.

    Callers that enforce a limit (chat credits, voice minutes) must fail closed
    on this rather than succeeding against a per-instance cache that no other
    instance of the service can see.
    """


# `mutate(current_document_or_none, write)` — call `write(data)` to persist.
Mutator = Callable[[Optional[Dict[str, Any]], Callable[[Dict[str, Any]], None]], T]


class DocumentStore(Protocol):
    def get_document(self, collection: str, doc_id: str) -> Optional[Dict[str, Any]]: ...
    def set_document(self, collection: str, doc_id: str, data: Dict[str, Any]) -> None: ...
    def delete_document(self, collection: str, doc_id: str) -> bool: ...
    def list_documents(self, collection: str, prefix: str = "") -> List[Dict[str, Any]]: ...
    def transact(self, collection: str, doc_id: str, mutate: Mutator[T]) -> T: ...


class InMemoryStore:
    """In-memory key-value document store for test/dev and as the read cache.

    Thread-safe: FastAPI runs sync route handlers in a worker thread pool, so two
    requests genuinely touch this concurrently.
    """

    durable = False

    def __init__(self, *, max_docs_per_collection: int = 0) -> None:
        self._collections: Dict[str, Dict[str, Dict[str, Any]]] = {}
        self._max_docs = max_docs_per_collection
        self._lock = threading.RLock()

    def get_document(self, collection: str, doc_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            doc = self._collections.get(collection, {}).get(doc_id)
            return dict(doc) if doc is not None else None

    def set_document(self, collection: str, doc_id: str, data: Dict[str, Any]) -> None:
        with self._lock:
            col = self._collections.setdefault(collection, {})
            col[doc_id] = dict(data)
            if self._max_docs and len(col) > self._max_docs:
                # Insertion-ordered dict: drop the coldest entries.
                for stale in list(col)[: len(col) - self._max_docs]:
                    col.pop(stale, None)

    def delete_document(self, collection: str, doc_id: str) -> bool:
        with self._lock:
            return self._collections.get(collection, {}).pop(doc_id, None) is not None

    def list_documents(self, collection: str, prefix: str = "") -> List[Dict[str, Any]]:
        with self._lock:
            col = self._collections.get(collection, {})
            if not prefix:
                return [dict(v) for v in col.values()]
            return [dict(v) for k, v in col.items() if k.startswith(prefix)]

    def transact(self, collection: str, doc_id: str, mutate: Mutator[T]) -> T:
        """Read-modify-write under the store lock.

        The single-process equivalent of a Firestore transaction: two concurrent
        quota reserves cannot both read the same pre-write value.
        """
        with self._lock:
            current = self._collections.get(collection, {}).get(doc_id)

            def _write(data: Dict[str, Any]) -> None:
                self.set_document(collection, doc_id, data)

            return mutate(dict(current) if current is not None else None, _write)


class _CloudBreaker:
    """Half-open circuit breaker around the Firestore client."""

    def __init__(self, *, threshold: int, cooldown: float) -> None:
        self._threshold = threshold
        self._cooldown = cooldown
        self._failures = 0
        self._opened_at = 0.0
        self._lock = threading.Lock()

    @property
    def closed(self) -> bool:
        """True when a call should be attempted — closed, or cooled down enough to probe."""
        with self._lock:
            if self._failures < self._threshold:
                return True
            return (time.monotonic() - self._opened_at) >= self._cooldown

    def record_success(self) -> None:
        with self._lock:
            if self._failures:
                logger.info("store_cloud_recovered after_failures=%s", self._failures)
            self._failures = 0
            self._opened_at = 0.0

    def record_failure(self, *, permanent: bool = False) -> None:
        with self._lock:
            # A configuration fault is not one more flaky call — it is the whole
            # backend being wrong, so it opens the breaker on the first hit.
            self._failures = self._threshold if permanent else self._failures + 1
            if self._failures >= self._threshold:
                # A failed probe restarts the cooldown rather than hammering.
                self._opened_at = time.monotonic()
                if self._failures == self._threshold:
                    logger.error(
                        "store_cloud_degraded failures=%s cooldown_s=%s — durable writes are failing",
                        self._failures,
                        self._cooldown,
                    )


# Retrying these wastes a request and delays the caller: the answer will not
# change until someone fixes credentials, IAM, or the database id. They are
# configuration faults, so they open the breaker immediately rather than
# burning the failure budget three requests at a time.
_PERMANENT_ERROR_NAMES = frozenset(
    {
        "NotFound",
        "PermissionDenied",
        "Unauthenticated",
        "InvalidArgument",
        "FailedPrecondition",
        "Unimplemented",
        "DefaultCredentialsError",
    }
)


def is_permanent_store_error(exc: BaseException) -> bool:
    """Is retrying this pointless? Matched by class name because the concrete
    exception type differs between the gRPC and REST Firestore transports."""
    return any(kind.__name__ in _PERMANENT_ERROR_NAMES for kind in type(exc).__mro__)


def _with_retry(operation: str, call: Callable[[], T]) -> T:
    """Retry transient Firestore failures with bounded exponential backoff."""
    last: Exception | None = None
    for attempt in range(RETRY_ATTEMPTS):
        try:
            return call()
        except Exception as exc:  # the provider exception hierarchy varies by transport
            last = exc
            if attempt == RETRY_ATTEMPTS - 1 or is_permanent_store_error(exc):
                break
            logger.warning(
                "store_retry operation=%s attempt=%s/%s error=%s",
                operation,
                attempt + 1,
                RETRY_ATTEMPTS,
                type(exc).__name__,
            )
            time.sleep(RETRY_BASE_DELAY_SECONDS * (2**attempt))
    assert last is not None
    raise last


class FirestoreStore:
    """Cloud Firestore document store with a read-through cache and a real breaker.

    Reads may be served from cache while the cloud is degraded, because a stale
    read is better than an outage. Writes are never *reported* as durable when
    they did not reach Firestore — they raise `StoreUnavailable`, so a caller
    enforcing a limit fails closed instead of trusting per-instance memory.
    """

    def __init__(self, db: Any) -> None:
        self._db = db
        self._cache = InMemoryStore(max_docs_per_collection=CACHE_MAX_DOCS_PER_COLLECTION)
        self._breaker = _CloudBreaker(
            threshold=BREAKER_FAILURE_THRESHOLD, cooldown=BREAKER_COOLDOWN_SECONDS
        )

    @property
    def durable(self) -> bool:
        """Whether durable, cross-instance storage is currently reachable."""
        return self._breaker.closed

    def get_document(self, collection: str, doc_id: str) -> Optional[Dict[str, Any]]:
        if not self._breaker.closed:
            return self._cache.get_document(collection, doc_id)
        try:
            snapshot = _with_retry(
                "get_document", lambda: self._db.collection(collection).document(doc_id).get()
            )
            self._breaker.record_success()
        except Exception as exc:
            self._breaker.record_failure(permanent=is_permanent_store_error(exc))
            logger.warning(
                "store_get_failed collection=%s error=%s — serving cache",
                collection,
                type(exc).__name__,
            )
            return self._cache.get_document(collection, doc_id)
        if snapshot.exists:
            data = snapshot.to_dict()
            self._cache.set_document(collection, doc_id, data)
            return data
        # Absent in the cloud is absent. Falling back to a cached copy here
        # resurrected documents the user had deleted.
        self._cache.delete_document(collection, doc_id)
        return None

    def set_document(self, collection: str, doc_id: str, data: Dict[str, Any]) -> None:
        if not self._breaker.closed:
            raise StoreUnavailable(f"durable write unavailable for {collection}/{doc_id}")
        try:
            _with_retry(
                "set_document",
                lambda: self._db.collection(collection).document(doc_id).set(data, merge=True),
            )
            self._breaker.record_success()
        except Exception as exc:
            self._breaker.record_failure(permanent=is_permanent_store_error(exc))
            logger.error(
                "store_set_failed collection=%s error=%s — write is not durable",
                collection,
                type(exc).__name__,
            )
            raise StoreUnavailable(f"durable write failed for {collection}/{doc_id}") from exc
        self._cache.set_document(collection, doc_id, data)

    def delete_document(self, collection: str, doc_id: str) -> bool:
        if not self._breaker.closed:
            raise StoreUnavailable(f"durable delete unavailable for {collection}/{doc_id}")
        try:
            _with_retry(
                "delete_document", lambda: self._db.collection(collection).document(doc_id).delete()
            )
            self._breaker.record_success()
        except Exception as exc:
            self._breaker.record_failure(permanent=is_permanent_store_error(exc))
            logger.error("store_delete_failed collection=%s error=%s", collection, type(exc).__name__)
            raise StoreUnavailable(f"durable delete failed for {collection}/{doc_id}") from exc
        self._cache.delete_document(collection, doc_id)
        return True

    def list_documents(self, collection: str, prefix: str = "") -> List[Dict[str, Any]]:
        if not self._breaker.closed:
            return self._cache.list_documents(collection, prefix)
        try:
            docs = _with_retry("list_documents", lambda: list(self._query(collection, prefix)))
            self._breaker.record_success()
        except Exception as exc:
            self._breaker.record_failure(permanent=is_permanent_store_error(exc))
            logger.warning(
                "store_list_failed collection=%s error=%s — serving cache",
                collection,
                type(exc).__name__,
            )
            return self._cache.list_documents(collection, prefix)
        # The cloud is authoritative for a listing. Merging cached rows in made
        # deleted documents reappear and let one instance contradict another.
        return [d.to_dict() for d in docs]

    def _query(self, collection: str, prefix: str) -> Any:
        coll_ref = self._db.collection(collection)
        if not prefix:
            return coll_ref.stream()
        end_prefix = prefix[:-1] + chr(ord(prefix[-1]) + 1)
        return coll_ref.where("__name__", ">=", prefix).where("__name__", "<", end_prefix).stream()

    def transact(self, collection: str, doc_id: str, mutate: Mutator[T]) -> T:
        """Run `mutate` inside a Firestore transaction.

        Firestore retries the body on contention, so `mutate` must have no side
        effects outside the store.
        """
        if not self._breaker.closed:
            raise StoreUnavailable(f"transaction unavailable for {collection}/{doc_id}")
        try:
            from google.cloud import firestore as _firestore  # optional dependency
        except ImportError as exc:  # pragma: no cover - the client implies the package
            raise StoreUnavailable("firestore transactions are unavailable") from exc

        doc_ref = self._db.collection(collection).document(doc_id)

        @_firestore.transactional
        def _run(transaction: Any) -> T:
            snapshot = doc_ref.get(transaction=transaction)
            current = snapshot.to_dict() if snapshot.exists else None
            return mutate(current, lambda data: transaction.set(doc_ref, data))

        try:
            result = _run(self._db.transaction())
            self._breaker.record_success()
            return result
        except Exception as exc:
            self._breaker.record_failure(permanent=is_permanent_store_error(exc))
            logger.error(
                "store_transaction_failed collection=%s error=%s", collection, type(exc).__name__
            )
            raise StoreUnavailable(f"transaction failed for {collection}/{doc_id}") from exc


def _init_firestore_client() -> Optional[Any]:
    enable_firebase = os.environ.get("ENABLE_FIREBASE", "true").strip().lower()
    if enable_firebase in ("false", "0", "no"):
        return None

    try:
        import firebase_admin
        from firebase_admin import credentials, firestore

        app_name = os.environ.get("FIREBASE_APP_NAME", "mindpal").strip() or "mindpal"
        if app_name in firebase_admin._apps:
            app = firebase_admin.get_app(app_name)
        else:
            raw_json = os.environ.get("FIREBASE_CREDENTIALS_JSON", "").strip()
            cred = None
            if raw_json:
                data = json.loads(raw_json)
                private_key = str(data.get("private_key", ""))
                if "\\n" in private_key:
                    data["private_key"] = private_key.replace("\\n", "\n")
                cred = credentials.Certificate(data)
            else:
                cred_path = (
                    os.environ.get("FIREBASE_CREDENTIALS_PATH", "").strip()
                    or os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
                )
                if cred_path and Path(cred_path).exists():
                    cred = credentials.Certificate(cred_path)
                elif Path("firebase-credentials-minified.json").exists():
                    cred = credentials.Certificate("firebase-credentials-minified.json")
                else:
                    cred = credentials.ApplicationDefault()

            project_id = (
                os.environ.get("FIREBASE_PROJECT_ID", "").strip()
                or os.environ.get("GOOGLE_CLOUD_PROJECT", "").strip()
                or "mindpal-official-0"
            )
            app = firebase_admin.initialize_app(cred, {"projectId": project_id}, name=app_name)

        database_id = os.environ.get("FIRESTORE_DATABASE_ID", "").strip() or "(default)"
        if database_id in ("(default)", "default"):
            return firestore.client(app=app)
        return firestore.client(app=app, database_id=database_id)
    except Exception as e:
        logger.warning("Cloud Firestore client initialization fallback: %s", e)
        return None


def _database_exists(client: Any) -> bool:
    """One cheap read to prove the database is actually there.

    Building a Firestore client never contacts the server: it succeeds against a
    project whose database was never created. Wrapping that handle in a
    FirestoreStore produced a store that refused every durable write, and because
    the voice quota hold is deliberately fail-closed, the whole product answered
    "Live voice is briefly unavailable" on a machine that simply had no database.

    A permanent error here (no such database, no permission) means this process
    has no cloud storage at all and should say so up front. A transient one is a
    real outage, where the breaker and the fail-closed writes are correct.
    """
    try:
        client.collection("_startup_probe").document("_probe").get()
        return True
    except Exception as exc:  # transport-specific hierarchy
        if is_permanent_store_error(exc):
            logger.error(
                "store_probe_failed error=%s — no usable Firestore database for this project",
                type(exc).__name__,
            )
            return False
        logger.warning(
            "store_probe_inconclusive error=%s — treating Firestore as present but degraded",
            type(exc).__name__,
        )
        return True


_client = _init_firestore_client()
if _client is not None and not _database_exists(_client):
    _client = None
_GLOBAL_STORE: DocumentStore = FirestoreStore(_client) if _client is not None else InMemoryStore()

if _client is None:
    logger.warning(
        "store_backend=in_memory — no Firestore client. State is per-process and not durable; "
        "chat credits and voice minutes cannot be enforced across instances."
    )


def get_store() -> DocumentStore:
    return _GLOBAL_STORE


def store_is_durable(store: Any | None = None) -> bool:
    """Whether writes to this store reach shared, cross-instance storage."""
    return bool(getattr(store if store is not None else _GLOBAL_STORE, "durable", False))
