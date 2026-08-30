from __future__ import annotations

import asyncio

import pytest

from backend.services.job_queue_service import AsyncJobQueueService


@pytest.mark.asyncio
async def test_async_job_queue_executes_successful_jobs() -> None:
    queue = AsyncJobQueueService(max_workers=1, retry_backoff_seconds=0.05)
    results: list[str] = []

    def handler(payload):
        results.append(payload["value"])
        return payload["value"].upper()

    queue.register_handler("echo", handler)
    await queue.start()
    try:
        job = await queue.enqueue("echo", {"value": "hello"})
        await asyncio.sleep(0.25)
        completed = await queue.get_completed(job.id)
        assert completed is not None
        assert completed.status == "succeeded"
        assert completed.result == "HELLO"
        assert results == ["hello"]
    finally:
        await queue.stop()


@pytest.mark.asyncio
async def test_async_job_queue_retries_and_dead_letters_after_limit() -> None:
    queue = AsyncJobQueueService(max_workers=1, retry_backoff_seconds=0.05)
    attempts: list[int] = []

    def handler(payload):
        attempts.append(len(attempts) + 1)
        if len(attempts) < 3:
            raise RuntimeError("temporary failure")
        return "ok"

    queue.register_handler("flaky", handler)
    await queue.start()
    try:
        job = await queue.enqueue("flaky", {"value": 1}, max_attempts=3)
        await asyncio.sleep(0.5)
        completed = await queue.get_completed(job.id)
        assert completed is not None
        assert completed.status == "succeeded"
        assert completed.result == "ok"
        assert attempts == [1, 2, 3]

        dead = await queue.get_dead_letters()
        assert dead == []
    finally:
        await queue.stop()


@pytest.mark.asyncio
async def test_async_job_queue_dead_letters_unhandled_jobs() -> None:
    queue = AsyncJobQueueService(max_workers=1, retry_backoff_seconds=0.05)
    await queue.start()
    try:
        job = await queue.enqueue("missing", {"value": "nope"}, max_attempts=2)
        await asyncio.sleep(0.2)
        dead = await queue.get_dead_letters()
        assert any(item.id == job.id for item in dead)
        assert dead[0].status == "dead_letter"
    finally:
        await queue.stop()
