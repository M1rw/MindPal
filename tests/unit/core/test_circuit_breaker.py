# Test circuit breaker

import pytest
import asyncio
from backend.services.core.circuit_breaker import (
    CircuitBreaker,
    CircuitBreakerState,
    CircuitBreakerOpen,
)


@pytest.fixture
def circuit_breaker():
    return CircuitBreaker(
        name="test_breaker",
        failure_threshold=2,
        success_threshold=1,
        timeout_seconds=1,
    )


@pytest.mark.asyncio
async def test_circuit_breaker_closed_success(circuit_breaker):
    """Test circuit breaker allows calls when closed."""
    
    async def success_fn():
        return "success"
    
    result = await circuit_breaker.call(success_fn)
    
    assert result == "success"
    assert circuit_breaker.state == CircuitBreakerState.CLOSED


@pytest.mark.asyncio
async def test_circuit_breaker_opens_on_failures(circuit_breaker):
    """Test circuit breaker opens after threshold failures."""
    
    async def failure_fn():
        raise Exception("Test failure")
    
    # First failure
    with pytest.raises(Exception):
        await circuit_breaker.call(failure_fn)
    
    # Still closed
    assert circuit_breaker.state == CircuitBreakerState.CLOSED
    
    # Second failure - should open
    with pytest.raises(Exception):
        await circuit_breaker.call(failure_fn)
    
    # Now open
    assert circuit_breaker.state == CircuitBreakerState.OPEN


@pytest.mark.asyncio
async def test_circuit_breaker_rejects_calls_when_open(circuit_breaker):
    """Test circuit breaker rejects calls when open."""
    
    async def failure_fn():
        raise Exception("Test failure")
    
    # Open the breaker
    for _ in range(2):
        with pytest.raises(Exception):
            await circuit_breaker.call(failure_fn)
    
    # Circuit should be open
    assert circuit_breaker.state == CircuitBreakerState.OPEN
    
    # Further calls should be rejected immediately
    with pytest.raises(CircuitBreakerOpen):
        await circuit_breaker.call(failure_fn)


@pytest.mark.asyncio
async def test_circuit_breaker_half_open_on_timeout(circuit_breaker):
    """Test circuit breaker enters half-open after timeout."""
    
    async def failure_fn():
        raise Exception("Test failure")
    
    # Open the breaker
    for _ in range(2):
        with pytest.raises(Exception):
            await circuit_breaker.call(failure_fn)
    
    assert circuit_breaker.state == CircuitBreakerState.OPEN
    
    # Wait for timeout
    await asyncio.sleep(1.1)
    
    # Should transition to half-open
    assert circuit_breaker.state == CircuitBreakerState.HALF_OPEN


@pytest.mark.asyncio
async def test_circuit_breaker_closes_on_success_from_half_open(circuit_breaker):
    """Test circuit breaker closes after successful recovery."""
    
    async def failure_fn():
        raise Exception("Test failure")
    
    async def success_fn():
        return "success"
    
    # Open the breaker
    for _ in range(2):
        with pytest.raises(Exception):
            await circuit_breaker.call(failure_fn)
    
    # Wait for timeout to half-open
    await asyncio.sleep(1.1)
    
    # Successful call should close it
    result = await circuit_breaker.call(success_fn)
    
    assert result == "success"
    assert circuit_breaker.state == CircuitBreakerState.CLOSED


@pytest.mark.asyncio
async def test_circuit_breaker_decorator(circuit_breaker):
    """Test decorator usage."""
    
    from backend.services.core.circuit_breaker import circuit_breaker as cb_decorator
    
    call_count = {"value": 0}
    
    @cb_decorator(circuit_breaker)
    async def failing_function():
        call_count["value"] += 1
        if call_count["value"] < 3:
            raise Exception("Temporary failure")
        return "success"
    
    # First two calls fail
    with pytest.raises(Exception):
        await failing_function()
    
    with pytest.raises(Exception):
        await failing_function()
    
    # Circuit should be open
    with pytest.raises(CircuitBreakerOpen):
        await failing_function()
    
    # Wait for recovery
    await asyncio.sleep(1.1)
    
    # Next call should succeed and close circuit
    result = await failing_function()
    assert result == "success"

