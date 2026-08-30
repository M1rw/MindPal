# tests/unit/core/test_circuit_breaker.py

import pytest
import asyncio
from backend.services.core.circuit_breaker import (
    CircuitBreaker,
    CircuitBreakerError,
    CircuitBreakerOpen,
    CircuitBreakerState,
    CircuitState,
)


@pytest.fixture
def cb():
    return CircuitBreaker(
        name="test_cb",
        failure_threshold=2,
        recovery_timeout_seconds=1,
    )


@pytest.mark.asyncio
async def test_circuit_breaker_success(cb):
    async def ok_fn():
        return "ok"

    res = await cb.call(ok_fn)
    assert res == "ok"
    assert cb.state == CircuitState.CLOSED


@pytest.mark.asyncio
async def test_circuit_breaker_opens_on_failures(cb):
    async def fail_fn():
        raise RuntimeError("failed")

    with pytest.raises(RuntimeError):
        await cb.call(fail_fn)
    assert cb.state == CircuitState.CLOSED

    with pytest.raises(RuntimeError):
        await cb.call(fail_fn)
    assert cb.state == CircuitState.OPEN

    with pytest.raises(CircuitBreakerError):
        await cb.call(fail_fn)


@pytest.mark.asyncio
async def test_circuit_breaker_half_open_recovery(cb):
    async def fail_fn():
        raise RuntimeError("failed")

    async def ok_fn():
        return "ok"

    for _ in range(2):
        with pytest.raises(RuntimeError):
            await cb.call(fail_fn)

    assert cb.state == CircuitState.OPEN

    await asyncio.sleep(1.1)

    res = await cb.call(ok_fn)
    assert res == "ok"
    assert cb.state == CircuitState.CLOSED
