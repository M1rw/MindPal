# backend/tasks/background_jobs.py

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping, Sequence
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from functools import lru_cache
from typing import Any

from backend.core.security import generate_request_id, redact_basic_pii, safe_truncate, sanitize_text
from backend.models.memory import MemoryCompactionRequest
from backend.models.safety import SafetyEvent


MAX_JOB_ID_CHARS = 120
MAX_KIND_CHARS = 80
MAX_ERROR_CHARS = 500
MAX_METADATA_VALUE_CHARS = 300
MAX_RESULT_VALUE_CHARS = 500
DEFAULT_MAX_QUEUE_SIZE = 200
DEFAULT_MAX_HISTORY = 500
DEFAULT_WORKER_COUNT = 2


class BackgroundJobStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    DROPPED = "dropped"


class BackgroundJobKind(str, Enum):
    MEMORY_COMPACTION = "memory_compaction"
    SAFETY_EVENT = "safety_event"
    CALLABLE = "callable"


@dataclass(frozen=True, slots=True)
class BackgroundJobResult:
    job_id: str
    kind: BackgroundJobKind
    status: BackgroundJobStatus
    request_id: str | None = None
    user_id_hash: str | None = None
    queued: bool = False
    inline: bool = False
    created_at: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    output: Any = None
    error_code: str | None = None
    error_message: str | None = None


@dataclass(slots=True)
class BackgroundJob:
    job_id: str
    kind: BackgroundJobKind
    coro_factory: Callable[[], Awaitable[Any]] = field(repr=False)
    request_id: str | None = None
    user_id_hash: str | None = None
    metadata: dict[str, str | int | float | bool | None] = field(default_factory=dict)
    created_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())


class BackgroundJobRunner:
    """
    Bounded in-process async background runner.

    This is intentionally small and non-durable.

    Use it for non-critical best-effort work:
    - memory compaction after a response
    - safety event persistence
    - lightweight notification hooks later

    Do not use it for:
    - mandatory crisis response
    - payment/accounting operations
    - jobs that must survive process restart
    - raw chat-log storage
    """

    def __init__(
        self,
        *,
        max_queue_size: int = DEFAULT_MAX_QUEUE_SIZE,
        max_history: int = DEFAULT_MAX_HISTORY,
        worker_count: int = DEFAULT_WORKER_COUNT,
        auto_start: bool = True,
    ) -> None:
        self.max_queue_size = max(1, int(max_queue_size))
        self.max_history = max(1, int(max_history))
        self.worker_count = max(1, int(worker_count))
        self.auto_start = bool(auto_start)

        self._queue: asyncio.Queue[BackgroundJob] | None = None
        self._workers: list[asyncio.Task[None]] = []
        self._history: dict[str, BackgroundJobResult] = {}
        self._lock = asyncio.Lock()
        self._started = False
        self._stopping = False

    @property
    def started(self) -> bool:
        return self._started

    async def start(self) -> None:
        if self._started:
            return

        self._queue = asyncio.Queue(maxsize=self.max_queue_size)
        self._stopping = False
        self._started = True
        self._workers = [
            asyncio.create_task(self._worker_loop(index), name=f"mindpal-bg-{index}")
            for index in range(self.worker_count)
        ]

    async def stop(self, *, drain: bool = True, timeout_seconds: float = 5.0) -> None:
        if not self._started:
            return

        self._stopping = True

        queue = self._queue
        if drain and queue is not None:
            with suppress(asyncio.TimeoutError):
                await asyncio.wait_for(queue.join(), timeout=timeout_seconds)

        for worker in self._workers:
            worker.cancel()

        for worker in self._workers:
            with suppress(asyncio.CancelledError):
                await worker

        self._workers.clear()
        self._queue = None
        self._started = False
        self._stopping = False

    async def submit(
        self,
        *,
        kind: BackgroundJobKind | str,
        coro_factory: Callable[[], Awaitable[Any]],
        request_id: str | None = None,
        user_id_hash: str | None = None,
        metadata: dict[str, Any] | None = None,
        run_inline_if_unavailable: bool = True,
    ) -> BackgroundJobResult:
        resolved_kind = _normalize_kind(kind)
        job = BackgroundJob(
            job_id=generate_request_id(),
            kind=resolved_kind,
            coro_factory=coro_factory,
            request_id=_optional_clean(request_id, 120),
            user_id_hash=_optional_clean(user_id_hash, 120),
            metadata=_sanitize_metadata(metadata or {}),
        )

        if self.auto_start and not self._started:
            await self.start()

        if not self._started or self._queue is None or self._stopping:
            if run_inline_if_unavailable:
                return await self._execute(job, inline=True)

            result = _result_for_job(
                job,
                status=BackgroundJobStatus.DROPPED,
                queued=False,
                inline=False,
                error_code="runner_not_started",
                error_message="Background runner is not started",
            )
            await self._remember(result)
            return result

        try:
            self._queue.put_nowait(job)
        except asyncio.QueueFull:
            if run_inline_if_unavailable:
                return await self._execute(job, inline=True)

            result = _result_for_job(
                job,
                status=BackgroundJobStatus.DROPPED,
                queued=False,
                inline=False,
                error_code="queue_full",
                error_message="Background queue is full",
            )
            await self._remember(result)
            return result

        result = _result_for_job(
            job,
            status=BackgroundJobStatus.QUEUED,
            queued=True,
            inline=False,
        )
        await self._remember(result)
        return result

    async def get_result(self, job_id: str) -> BackgroundJobResult | None:
        clean_id = sanitize_text(job_id, MAX_JOB_ID_CHARS)

        async with self._lock:
            return self._history.get(clean_id)

    async def health(self) -> dict[str, Any]:
        queue_size = self._queue.qsize() if self._queue is not None else 0

        return {
            "mode": "in_process_non_durable",
            "started": self._started,
            "stopping": self._stopping,
            "worker_count": len(self._workers),
            "max_queue_size": self.max_queue_size,
            "queue_size": queue_size,
            "max_history": self.max_history,
            "history_size": len(self._history),
            "durable": False,
            "stores_raw_chat": False,
        }

    async def _worker_loop(self, index: int) -> None:
        while True:
            if self._queue is None:
                await asyncio.sleep(0)
                continue

            job = await self._queue.get()

            try:
                await self._execute(job, inline=False)
            finally:
                self._queue.task_done()

    async def _execute(self, job: BackgroundJob, *, inline: bool) -> BackgroundJobResult:
        started_at = datetime.now(UTC).isoformat()

        running = _result_for_job(
            job,
            status=BackgroundJobStatus.RUNNING,
            queued=False,
            inline=inline,
            started_at=started_at,
        )
        await self._remember(running)

        try:
            output = await job.coro_factory()
            result = _result_for_job(
                job,
                status=BackgroundJobStatus.SUCCEEDED,
                queued=False,
                inline=inline,
                started_at=started_at,
                finished_at=datetime.now(UTC).isoformat(),
                output=_sanitize_output(output),
            )
            await self._remember(result)
            return result

        except asyncio.CancelledError:
            raise

        except Exception as exc:
            result = _result_for_job(
                job,
                status=BackgroundJobStatus.FAILED,
                queued=False,
                inline=inline,
                started_at=started_at,
                finished_at=datetime.now(UTC).isoformat(),
                error_code=exc.__class__.__name__,
                error_message=redact_basic_pii(sanitize_text(str(exc), MAX_ERROR_CHARS)),
            )
            await self._remember(result)
            return result

    async def _remember(self, result: BackgroundJobResult) -> None:
        async with self._lock:
            self._history[result.job_id] = result

            if len(self._history) <= self.max_history:
                return

            overflow = len(self._history) - self.max_history
            for key in list(self._history.keys())[:overflow]:
                self._history.pop(key, None)


async def enqueue_memory_compaction(
    runner: BackgroundJobRunner,
    *,
    services: Any,
    request: MemoryCompactionRequest,
    save: bool = True,
) -> BackgroundJobResult:
    """
    Enqueue memory compaction.

    The job output intentionally returns only metadata, not memory contents.
    """

    async def work() -> dict[str, Any]:
        result = await services.memory.compact(request)

        if save and result.changed:
            await services.db.save_memory(result.summary)

        return {
            "changed": result.changed,
            "items_added": result.items_added,
            "saved": bool(save and result.changed),
        }

    return await runner.submit(
        kind=BackgroundJobKind.MEMORY_COMPACTION,
        coro_factory=work,
        request_id=request.request_id,
        user_id_hash=request.user_id_hash,
        metadata={
            "save": save,
            "interaction_count": len(request.interactions),
        },
    )


async def enqueue_safety_event(
    runner: BackgroundJobRunner,
    *,
    services: Any,
    event: SafetyEvent,
) -> BackgroundJobResult:
    """
    Enqueue sanitized safety event persistence.
    """

    async def work() -> dict[str, Any]:
        event_id = await services.db.append_safety_event(event)
        return {
            "event_id": event_id,
            "logged": True,
        }

    return await runner.submit(
        kind=BackgroundJobKind.SAFETY_EVENT,
        coro_factory=work,
        request_id=event.request_id,
        user_id_hash=event.user_id_hash,
        metadata={
            "level": event.decision.level.value,
            "source": event.source.value,
        },
    )


@lru_cache(maxsize=1)
def get_background_job_runner() -> BackgroundJobRunner:
    return BackgroundJobRunner()


def reset_background_job_runner_for_tests() -> None:
    get_background_job_runner.cache_clear()


def _result_for_job(
    job: BackgroundJob,
    *,
    status: BackgroundJobStatus,
    queued: bool,
    inline: bool,
    started_at: str | None = None,
    finished_at: str | None = None,
    output: Any = None,
    error_code: str | None = None,
    error_message: str | None = None,
) -> BackgroundJobResult:
    return BackgroundJobResult(
        job_id=sanitize_text(job.job_id, MAX_JOB_ID_CHARS),
        kind=job.kind,
        status=status,
        request_id=job.request_id,
        user_id_hash=job.user_id_hash,
        queued=queued,
        inline=inline,
        created_at=job.created_at,
        started_at=started_at,
        finished_at=finished_at,
        output=output,
        error_code=_optional_clean(error_code, 120),
        error_message=_optional_clean(error_message, MAX_ERROR_CHARS),
    )


def _normalize_kind(kind: BackgroundJobKind | str) -> BackgroundJobKind:
    if isinstance(kind, BackgroundJobKind):
        return kind

    cleaned = sanitize_text(str(kind or ""), MAX_KIND_CHARS)

    try:
        return BackgroundJobKind(cleaned)
    except ValueError:
        return BackgroundJobKind.CALLABLE


def _optional_clean(value: object, max_chars: int) -> str | None:
    cleaned = sanitize_text(str(value or ""), max_chars)
    return cleaned or None


def _sanitize_metadata(metadata: Mapping[str, Any]) -> dict[str, str | int | float | bool | None]:
    clean: dict[str, str | int | float | bool | None] = {}

    for raw_key, raw_value in list(metadata.items())[:40]:
        key = sanitize_text(str(raw_key or ""), 80)

        if not key:
            continue

        key_lower = key.lower()
        if any(secret in key_lower for secret in ("token", "secret", "password", "cookie", "credential")):
            continue

        if raw_value is None or isinstance(raw_value, (bool, int, float)):
            clean[key] = raw_value
        else:
            clean[key] = redact_basic_pii(sanitize_text(str(raw_value), MAX_METADATA_VALUE_CHARS))

    return clean


def _sanitize_output(value: Any, *, depth: int = 3) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value

    if isinstance(value, str):
        return redact_basic_pii(safe_truncate(sanitize_text(value, MAX_RESULT_VALUE_CHARS), MAX_RESULT_VALUE_CHARS))

    if depth <= 0:
        return redact_basic_pii(safe_truncate(sanitize_text(str(value), MAX_RESULT_VALUE_CHARS), MAX_RESULT_VALUE_CHARS))

    if isinstance(value, Mapping):
        return {
            sanitize_text(str(key), 80): _sanitize_output(item, depth=depth - 1)
            for key, item in list(value.items())[:40]
            if sanitize_text(str(key), 80)
            and not _looks_sensitive_key(str(key))
        }

    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_sanitize_output(item, depth=depth - 1) for item in list(value)[:40]]

    return redact_basic_pii(safe_truncate(sanitize_text(str(value), MAX_RESULT_VALUE_CHARS), MAX_RESULT_VALUE_CHARS))


def _looks_sensitive_key(value: str) -> bool:
    key = value.lower().replace("-", "_")
    return any(part in key for part in ("token", "secret", "password", "cookie", "credential", "raw_chat"))