from __future__ import annotations

import asyncio
import hashlib
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, AsyncIterator

from backend.core.errors import RateLimitError
from backend.core.security import sanitize_text
from backend.services.db_service import DBService


@dataclass(frozen=True, slots=True)
class RateLimitDecision:
    allowed: bool
    remaining: int
    retry_after_seconds: int


@dataclass(slots=True)
class _SemaphoreEntry:
    semaphore: asyncio.Semaphore
    active: int
    max_concurrent: int
    last_used: float


class RateLimitService:
    """Distributed fixed-window limits plus bounded local concurrency guards.

    Request-count limits are persisted atomically through the configured database,
    so they apply across application instances. The semaphore is deliberately
    process-local: it protects each worker from request fan-out while the global
    quota and request limits remain the authoritative distributed controls.
    """

    COLLECTION = "rate_limit_buckets"
    MAX_CONCURRENCY_KEYS = 5_000
    CONCURRENCY_ENTRY_IDLE_SECONDS = 15 * 60

    def __init__(self, *, db: DBService) -> None:
        self.db = db
        self._locks: dict[str, _SemaphoreEntry] = {}
        self._locks_guard = asyncio.Lock()

    async def consume(
        self,
        *,
        scope: str,
        subject: str,
        limit: int,
        window_seconds: int,
        amount: int = 1,
    ) -> RateLimitDecision:
        scope = sanitize_text(scope, 80) or "default"
        subject = sanitize_text(subject, 160) or "anonymous"
        limit = max(1, int(limit))
        window_seconds = max(1, int(window_seconds))
        amount = max(1, int(amount))
        now = time.time()
        bucket = int(now // window_seconds)
        key = hashlib.sha256(f"{scope}:{subject}:{bucket}".encode()).hexdigest()
        result: dict[str, Any] = {}

        def updater(data: dict[str, Any]) -> dict[str, Any]:
            nonlocal result
            count = max(0, int(data.get("count") or 0))
            allowed = count + amount <= limit
            if allowed:
                count += amount
            expires_epoch = (bucket + 2) * window_seconds
            payload = {
                "scope": scope,
                "subject_hash": hashlib.sha256(subject.encode()).hexdigest(),
                "bucket": bucket,
                "count": count,
                "window_seconds": window_seconds,
                # Native timestamp makes Firestore TTL policies work without a
                # conversion job. Keep the numeric fields for deterministic math.
                "expires_at": datetime.fromtimestamp(expires_epoch, tz=timezone.utc),
                "updated_at": now,
            }
            result = {
                "allowed": allowed,
                "remaining": max(0, limit - count),
                "retry": max(1, int((bucket + 1) * window_seconds - now)),
            }
            return payload

        await self.db.provider.atomic_update_document(self.COLLECTION, key, updater)
        decision = RateLimitDecision(
            allowed=bool(result["allowed"]),
            remaining=int(result["remaining"]),
            retry_after_seconds=int(result["retry"]),
        )
        if not decision.allowed:
            raise RateLimitError(
                "Too many requests",
                details={"scope": scope, "retry_after_seconds": decision.retry_after_seconds},
            )
        return decision

    @asynccontextmanager
    async def concurrency(
        self,
        *,
        scope: str,
        subject: str,
        max_concurrent: int,
        timeout_seconds: float = 1.0,
    ) -> AsyncIterator[None]:
        clean_scope = sanitize_text(scope, 80) or "default"
        clean_subject = sanitize_text(subject, 160) or "anonymous"
        capacity = max(1, int(max_concurrent))
        key = hashlib.sha256(f"{clean_scope}:{clean_subject}".encode()).hexdigest()
        now = time.monotonic()

        async with self._locks_guard:
            await self._prune_concurrency_entries_locked(now)
            entry = self._locks.get(key)
            if entry is None:
                entry = _SemaphoreEntry(
                    semaphore=asyncio.Semaphore(capacity),
                    active=0,
                    max_concurrent=capacity,
                    last_used=now,
                )
                self._locks[key] = entry
            elif entry.max_concurrent != capacity and entry.active == 0:
                # Configuration changed while this process was alive. Rebuild only
                # when no request owns the old semaphore.
                entry = _SemaphoreEntry(
                    semaphore=asyncio.Semaphore(capacity),
                    active=0,
                    max_concurrent=capacity,
                    last_used=now,
                )
                self._locks[key] = entry
            entry.active += 1
            entry.last_used = now

        acquired = False
        try:
            await asyncio.wait_for(entry.semaphore.acquire(), timeout=max(0.05, float(timeout_seconds)))
            acquired = True
            yield
        except TimeoutError as exc:
            raise RateLimitError(
                "Too many concurrent requests",
                details={"scope": clean_scope, "retry_after_seconds": 1},
            ) from exc
        finally:
            if acquired:
                entry.semaphore.release()
            async with self._locks_guard:
                entry.active = max(0, entry.active - 1)
                entry.last_used = time.monotonic()

    async def _prune_concurrency_entries_locked(self, now: float) -> None:
        stale_keys = [
            key
            for key, entry in self._locks.items()
            if entry.active == 0 and now - entry.last_used >= self.CONCURRENCY_ENTRY_IDLE_SECONDS
        ]
        for key in stale_keys:
            self._locks.pop(key, None)

        if len(self._locks) <= self.MAX_CONCURRENCY_KEYS:
            return

        idle = sorted(
            ((key, entry.last_used) for key, entry in self._locks.items() if entry.active == 0),
            key=lambda item: item[1],
        )
        excess = len(self._locks) - self.MAX_CONCURRENCY_KEYS
        for key, _ in idle[:excess]:
            self._locks.pop(key, None)
