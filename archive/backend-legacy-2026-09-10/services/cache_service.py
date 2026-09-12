from __future__ import annotations

import hashlib
import json
import time
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from backend.core.config import Settings

try:  # pragma: no cover - optional dependency
    import redis.asyncio as redis_client  # type: ignore
except Exception:  # pragma: no cover - exercised when Redis is unavailable
    redis_client = None

T = TypeVar("T")
_SENTINEL = object()


class CacheService:
    """Redis-ready cache with a safe in-memory fallback for local/dev use.

    The service keeps the public async API stable regardless of backend. It is
    intentionally small and testable so it can sit in front of expensive LLM or
    retrieval flows without forcing a hard dependency on Redis at runtime.
    """

    def __init__(self, *, settings: Settings | None = None, default_ttl_seconds: int = 300,
                 namespace: str = "mindpal", backend: str = "memory", redis_url: str | None = None) -> None:
        if settings is not None:
            self.enabled = bool(getattr(settings, "ENABLE_CACHE", False))
            self.backend = str(getattr(settings, "CACHE_BACKEND", backend)).lower()
            self.default_ttl_seconds = max(1, int(getattr(settings, "CACHE_DEFAULT_TTL_SECONDS", default_ttl_seconds)))
            self.namespace = str(getattr(settings, "CACHE_NAMESPACE", namespace)).strip() or "mindpal"
            self.redis_url = str(getattr(settings, "REDIS_URL", redis_url or "")).strip()
        else:
            self.enabled = bool(backend == "redis")
            self.backend = str(backend).lower()
            self.default_ttl_seconds = max(1, int(default_ttl_seconds))
            self.namespace = str(namespace).strip() or "mindpal"
            self.redis_url = str(redis_url or "").strip()

        self._memory: dict[str, tuple[float, Any]] = {}
        self._redis = None
        if self.enabled and self.backend == "redis" and redis_client is not None and self.redis_url:
            try:
                self._redis = redis_client.Redis.from_url(self.redis_url, decode_responses=True)
                self.backend = "redis"
            except Exception:  # pragma: no cover - degrade gracefully
                self._redis = None
                self.backend = "memory"

    @staticmethod
    def _serialize(value: Any) -> str:
        return json.dumps(value, separators=(",", ":"), sort_keys=True)

    @staticmethod
    def _deserialize(raw: str | None) -> Any:
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return raw

    def _full_key(self, key: str) -> str:
        name = str(key).strip()
        if not name:
            raise ValueError("Cache key cannot be empty")
        return f"{self.namespace}:{name}"

    async def get(self, key: str, *, default: Any = None) -> Any:
        full_key = self._full_key(key)
        if self.backend == "redis" and self._redis is not None:
            value = await self._redis.get(full_key)
            if value is None:
                return default
            return self._deserialize(value)

        now = time.monotonic()
        entry = self._memory.get(full_key)
        if entry is None:
            return default
        expires_at, value = entry
        if expires_at <= now:
            self._memory.pop(full_key, None)
            return default
        return value

    async def set(self, key: str, value: Any, *, ttl_seconds: int | None = None) -> None:
        full_key = self._full_key(key)
        ttl = max(1, int(ttl_seconds or self.default_ttl_seconds))
        if self.backend == "redis" and self._redis is not None:
            await self._redis.set(full_key, self._serialize(value), ex=ttl)
            return

        self._memory[full_key] = (time.monotonic() + ttl, value)

    async def delete(self, key: str) -> bool:
        full_key = self._full_key(key)
        if self.backend == "redis" and self._redis is not None:
            deleted = await self._redis.delete(full_key)
            return bool(deleted)
        return self._memory.pop(full_key, None) is not None

    async def invalidate(self, prefix: str | None = None) -> int:
        if self.backend == "redis" and self._redis is not None:
            pattern = f"{self.namespace}:*" if prefix is None else f"{self.namespace}:{prefix}*"
            keys = [key async for key in self._redis.scan_iter(match=pattern)]
            if not keys:
                return 0
            await self._redis.delete(*keys)
            return len(keys)

        pattern = prefix
        removed = 0
        for cache_key in list(self._memory):
            if pattern is None or cache_key.startswith(f"{self.namespace}:{pattern}"):
                self._memory.pop(cache_key, None)
                removed += 1
        return removed

    async def get_or_set(self, key: str, *, ttl_seconds: int | None = None,
                         loader: Callable[[], Awaitable[T] | T]) -> T:
        cached = await self.get(key)
        if cached is not None:
            return cached
        value = loader()
        if hasattr(value, "__await__"):
            resolved = await value
        else:
            resolved = value
        await self.set(key, resolved, ttl_seconds=ttl_seconds)
        return resolved

    async def clear(self) -> None:
        if self.backend == "redis" and self._redis is not None:
            await self._redis.flushdb()
            return
        self._memory.clear()

    async def close(self) -> None:
        if self._redis is not None:
            await self._redis.close()
            self._redis = None

    @property
    def backend_type(self) -> str:
        return self.backend


def cache_key(*parts: Any) -> str:
    """Stable cache key builder for request-scoped or provider-scoped payloads."""
    payload = "|".join(str(part) for part in parts)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
