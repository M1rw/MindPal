from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable, Dict, Iterator, List, Optional, Protocol, Tuple, TypeVar

from backend.configs.runtime import behavior_config

logger = logging.getLogger("mindpal.store")
T = TypeVar("T")

_STORE_BEHAVIOR = behavior_config()["store"]
BREAKER_FAILURE_THRESHOLD = int(_STORE_BEHAVIOR["breaker_failure_threshold"])
BREAKER_COOLDOWN_SECONDS = float(_STORE_BEHAVIOR["breaker_cooldown_seconds"])
RETRY_ATTEMPTS = int(_STORE_BEHAVIOR["retry_attempts"])
RETRY_BASE_DELAY_SECONDS = float(_STORE_BEHAVIOR["retry_base_delay_seconds"])
CACHE_MAX_DOCS_PER_COLLECTION = int(_STORE_BEHAVIOR["cache_max_docs_per_collection"])


class StoreUnavailable(RuntimeError):
    """Durable storage could not serve an operation."""


Mutator = Callable[[Optional[Dict[str, Any]], Callable[[Dict[str, Any]], None]], T]


class DocumentStore(Protocol):
    def get_document(self, collection: str, doc_id: str) -> Optional[Dict[str, Any]]: ...
    def set_document(self, collection: str, doc_id: str, data: Dict[str, Any]) -> None: ...
    def delete_document(self, collection: str, doc_id: str) -> bool: ...
    def list_documents(self, collection: str, prefix: str = "") -> List[Dict[str, Any]]: ...
    def iter_documents(self, collection: str, prefix: str = "") -> Iterator[Tuple[str, Dict[str, Any]]]: ...
    def query_documents(self, collection: str, field: str, value: Any) -> List[Tuple[str, Dict[str, Any]]]: ...
    def transact(self, collection: str, doc_id: str, mutate: Mutator[T]) -> T: ...


class CloudBreaker:
    """Half-open circuit breaker shared by durable providers."""

    def __init__(self, *, threshold: int, cooldown: float) -> None:
        self._threshold = threshold
        self._cooldown = cooldown
        self._failures = 0
        self._opened_at = 0.0
        self._lock = threading.Lock()

    @property
    def closed(self) -> bool:
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
            self._failures = self._threshold if permanent else self._failures + 1
            if self._failures >= self._threshold:
                self._opened_at = time.monotonic()
                if self._failures == self._threshold:
                    logger.error(
                        "store_cloud_degraded failures=%s cooldown_s=%s",
                        self._failures,
                        self._cooldown,
                    )


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
    return any(kind.__name__ in _PERMANENT_ERROR_NAMES for kind in type(exc).__mro__)


def with_retry(operation: str, call: Callable[[], T]) -> T:
    last: Exception | None = None
    for attempt in range(RETRY_ATTEMPTS):
        try:
            return call()
        except Exception as exc:
            last = exc
            if type(exc).__name__ == "AppError":
                raise
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
    if last is None:  # unreachable: RETRY_ATTEMPTS >= 1
        raise StoreUnavailable(f"{operation} made no attempt")
    raise last

