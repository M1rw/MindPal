from __future__ import annotations

import asyncio
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


@dataclass(slots=True)
class QueuedJob:
    id: str
    name: str
    payload: dict[str, Any] = field(default_factory=dict)
    attempts: int = 0
    max_attempts: int = 3
    run_at: float = 0.0
    status: str = "queued"
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    result: Any = None
    error: str | None = None


class AsyncJobQueueService:
    """Small async job queue with retries and dead-letter handling.

    This intentionally does not require Redis so it stays lightweight and testable
    in local development and CI while still preserving production-friendly job
    semantics: enqueue, async execution, exponential backoff, and dead-letter
    handling.
    """

    def __init__(self, *, max_workers: int = 2, retry_backoff_seconds: float = 1.0) -> None:
        self.max_workers = max(1, int(max_workers))
        self.retry_backoff_seconds = max(0.1, float(retry_backoff_seconds))
        self._handlers: dict[str, Callable[[Any], Any | Awaitable[Any]]] = {}
        self._queue: asyncio.PriorityQueue[tuple[float, str, QueuedJob]] = asyncio.PriorityQueue()
        self._workers: list[asyncio.Task[None]] = []
        self._running = False
        self._completed: dict[str, QueuedJob] = {}
        self._dead_letters: dict[str, QueuedJob] = {}
        self._lock = asyncio.Lock()

    def register_handler(self, job_name: str, handler: Callable[[Any], Any | Awaitable[Any]]) -> None:
        self._handlers[job_name] = handler

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        for _ in range(self.max_workers):
            self._workers.append(asyncio.create_task(self._worker_loop()))

    async def stop(self) -> None:
        self._running = False
        for worker in self._workers:
            worker.cancel()
        await asyncio.gather(*self._workers, return_exceptions=True)
        self._workers.clear()

    async def enqueue(
        self,
        job_name: str,
        payload: Any | None = None,
        *,
        delay_seconds: float = 0.0,
        max_attempts: int = 3,
    ) -> QueuedJob:
        job = QueuedJob(
            id=f"job-{uuid.uuid4().hex}",
            name=job_name,
            payload={} if payload is None else payload,
            max_attempts=max(1, int(max_attempts)),
            run_at=time.time() + max(0.0, float(delay_seconds)),
        )
        await self._queue.put((job.run_at, job.id, job))
        return job

    async def _worker_loop(self) -> None:
        while self._running:
            try:
                scheduled_at, _, job = await asyncio.wait_for(self._queue.get(), timeout=0.25)
            except asyncio.TimeoutError:
                continue

            if scheduled_at > time.time():
                await self._queue.put((scheduled_at, job.id, job))
                await asyncio.sleep(min(0.25, max(0.0, scheduled_at - time.time())))
                continue

            await self._process_job(job)

    async def _process_job(self, job: QueuedJob) -> None:
        job.status = "running"
        job.updated_at = datetime.now(timezone.utc)

        handler = self._handlers.get(job.name)
        if handler is None:
            job.status = "dead_letter"
            job.error = f"No registered handler for job '{job.name}'"
            job.updated_at = datetime.now(timezone.utc)
            async with self._lock:
                self._dead_letters[job.id] = job
            return

        try:
            result = handler(job.payload)
            if asyncio.iscoroutine(result):
                result = await result
            job.result = result
            job.status = "succeeded"
            job.error = None
            job.updated_at = datetime.now(timezone.utc)
            async with self._lock:
                self._completed[job.id] = job
        except Exception as exc:  # pragma: no cover - exercised by tests with injected handlers
            job.attempts += 1
            job.error = str(exc)
            job.updated_at = datetime.now(timezone.utc)
            if job.attempts >= job.max_attempts:
                job.status = "dead_letter"
                async with self._lock:
                    self._dead_letters[job.id] = job
                return

            backoff = self.retry_backoff_seconds * (2 ** max(0, job.attempts - 1))
            job.status = "queued"
            job.run_at = time.time() + backoff
            await self._queue.put((job.run_at, job.id, job))

    async def get_completed(self, job_id: str) -> QueuedJob | None:
        async with self._lock:
            return self._completed.get(job_id)

    async def get_dead_letters(self) -> list[QueuedJob]:
        async with self._lock:
            return list(self._dead_letters.values())

    async def has_pending(self) -> bool:
        return not self._queue.empty()

    async def queue_size(self) -> int:
        return self._queue.qsize()


__all__ = ["AsyncJobQueueService", "QueuedJob"]
