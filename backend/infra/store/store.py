"""Document store gateway: provider selection and health.

Providers (MINDPAL_STORAGE_PROVIDER):

* ``firestore`` - Cloud Firestore through the shared Firebase Admin app. Chosen
  automatically when Firebase Admin credentials are configured, because that is
  where existing accounts' data lives.
* ``supabase`` - Postgres via PostgREST (``mindpal_documents``).
* ``memory`` - per-process, for tests and local work only.

A durable provider is never swapped for memory behind the operator's back. If
it is unreachable at boot, the instance keeps the durable provider in a
degraded state; its circuit breaker recovers when the backend does, and
anything that enforces a limit fails closed meanwhile.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

from backend.configs.runtime import ensure_runtime_ready
from backend.configs.settings import get_settings
from backend.configs.storage import configured_storage_provider, supabase_settings
from backend.infra.store.providers.firestore import FirestoreStore
from backend.infra.store.providers.memory import InMemoryStore
from backend.infra.store.providers.supabase import SupabaseStore
from backend.infra.store.shared import (
    BREAKER_COOLDOWN_SECONDS,
    BREAKER_FAILURE_THRESHOLD,
    CACHE_MAX_DOCS_PER_COLLECTION,
    DocumentStore,
    Mutator,
    StoreUnavailable,
    is_permanent_store_error,
)

logger = logging.getLogger("mindpal.store")
_HEALTH_CACHE_SECONDS = 5.0
_HEALTH_LOCK = threading.Lock()
_HEALTH_CACHE: tuple[float, dict[str, Any]] | None = None

__all__ = [
    "DocumentStore",
    "StoreUnavailable",
    "Mutator",
    "InMemoryStore",
    "SupabaseStore",
    "FirestoreStore",
    "BREAKER_FAILURE_THRESHOLD",
    "BREAKER_COOLDOWN_SECONDS",
    "CACHE_MAX_DOCS_PER_COLLECTION",
    "is_permanent_store_error",
    "build_store",
    "get_store",
    "store_is_durable",
    "storage_health",
]


def build_store(provider: str | None = None) -> DocumentStore:
    try:
        ensure_runtime_ready()
    except ValueError as exc:
        raise RuntimeError(str(exc)) from exc

    chosen = (provider or configured_storage_provider()).strip().lower()
    if chosen == "memory":
        if get_settings().environment.strip().lower() in {"production", "prod"}:
            logger.error(
                "store_backend=memory in production: data is per-instance and lost on restart. "
                "Configure Firebase Admin credentials or Supabase."
            )
        else:
            logger.warning("store_backend=memory (non-durable)")
        return InMemoryStore()
    if chosen == "firestore":
        logger.info("store_backend=firestore database=%s", get_settings().firestore_database_id)
        return FirestoreStore()
    if chosen == "supabase":
        url, key = supabase_settings()
        logger.info("store_backend=supabase")
        return SupabaseStore(url, key)
    raise RuntimeError(f"Unsupported MINDPAL_STORAGE_PROVIDER={chosen!r}")


_GLOBAL_STORE: DocumentStore = build_store()


def get_store() -> DocumentStore:
    return _GLOBAL_STORE


def store_is_durable(store: Any | None = None) -> bool:
    return bool(getattr(store if store is not None else _GLOBAL_STORE, "durable", False))


def storage_health(store: Any | None = None) -> dict[str, Any]:
    global _HEALTH_CACHE
    target = store if store is not None else _GLOBAL_STORE
    if store is None:
        now = time.monotonic()
        with _HEALTH_LOCK:
            if _HEALTH_CACHE is not None and now - _HEALTH_CACHE[0] < _HEALTH_CACHE_SECONDS:
                return dict(_HEALTH_CACHE[1])
    schema_health = getattr(target, "schema_health", None)
    if callable(schema_health):
        result = schema_health()
    else:
        result = {"provider": getattr(target, "provider_name", "memory"), "status": "ok"}
    result["durable"] = store_is_durable(target)
    if store is None:
        with _HEALTH_LOCK:
            _HEALTH_CACHE = (time.monotonic(), dict(result))
    return result
