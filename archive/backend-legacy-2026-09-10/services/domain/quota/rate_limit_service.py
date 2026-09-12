# backend/services/domain/quota/rate_limit_service.py

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
from backend.services.domain.storage import StorageService as DBService


@dataclass(frozen=True, slots=True)
class RateLimitDecision:
    allowed: bool
    remaining: int
    retry_after_seconds: int
    scope: str = "default"
    subject: str = "anonymous"


@dataclass(frozen=True, slots=True)
class RateLimitPolicy:
    """A single gate in a layered rate-limiting strategy."""

    scope: str
    limit: int
    window_seconds: int
    amount: int = 1
    subject: str | None = None
    provider: str | None = None
    endpoint: str | None = None

    def resolved_scope(self, default_subject: str) -> tuple[str, str]:
        resolved_subject = self.subject or default_subject
        scope_name = self.scope.strip() or "default"
        if self.provider:
            scope_name = f"{scope_name}:{sanitize_text(self.provider, 80) or 'provider'}"
        if self.endpoint:
            scope_name = f"{scope_name}:{sanitize_text(self.endpoint, 80) or 'endpoint'}"
        return scope_name, resolved_subject


@dataclass(slots=True)
class _SemaphoreEntry:
    semaphore: asyncio.Semaphore
    active: int
    max_concurrent: int
    last_used: float


class RateLimitService:
    """Distributed fixed-window limits plus bounded local concurrency guards."""

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
            scope=scope,
            subject=subject,
        )
        if not decision.allowed:
            raise RateLimitError(
                "Too many requests",
                details={
                    "scope": scope,
                    "subject": subject,
                    "retry_after_seconds": decision.retry_after_seconds,
                },
            )
        return decision

    async def consume_many(
        self,
        *,
        subject: str,
        policies: list[RateLimitPolicy | dict[str, Any]],
    ) -> list[RateLimitDecision]:
        if not policies:
            return []

        decisions: list[RateLimitDecision] = []
        for policy in policies:
            if isinstance(policy, dict):
                normalized = RateLimitPolicy(
                    scope=str(policy.get("scope") or "default"),
                    limit=int(policy.get("limit") or 1),
                    window_seconds=int(policy.get("window_seconds") or 60),
                    amount=int(policy.get("amount") or 1),
                    subject=policy.get("subject"),
                    provider=policy.get("provider"),
                    endpoint=policy.get("endpoint"),
                )
            else:
                normalized = policy

            scope_name, resolved_subject = normalized.resolved_scope(subject)
            decisions.append(
                await self.consume(
                    scope=scope_name,
                    subject=resolved_subject,
                    limit=normalized.limit,
                    window_seconds=normalized.window_seconds,
                    amount=normalized.amount,
                )
            )

        return decisions

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
