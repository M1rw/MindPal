# Enhanced Circuit Breaker Pattern

from __future__ import annotations

import asyncio
from datetime import datetime, timezone, timedelta
from enum import Enum
from functools import wraps
import logging
import time
from typing import Any, Awaitable, Callable, Optional, TypeVar

logger = logging.getLogger(__name__)

T = TypeVar('T')


class CircuitState(Enum):
    """States of the circuit breaker."""
    CLOSED = "closed"          # Normal operation, calls pass through
    OPEN = "open"              # Failing, calls are rejected
    HALF_OPEN = "half_open"    # Testing if recovered, limited calls allowed


# Aliases for backward compatibility
CircuitBreakerState = CircuitState


class CircuitBreakerError(Exception):
    """Raised when circuit breaker is OPEN."""
    pass


# Aliases for backward compatibility
CircuitBreakerOpen = CircuitBreakerError
CircuitBreakerOpenError = CircuitBreakerError


class CircuitBreakerMetrics:
    """Metrics collected by circuit breaker."""

    def __init__(self) -> None:
        self.total_calls = 0
        self.total_failures = 0
        self.total_successes = 0
        self.state_changes = 0
        self.last_state_change: Optional[datetime] = None

    def to_dict(self) -> dict[str, Any]:
        """Convert metrics to dictionary."""
        return {
            "total_calls": self.total_calls,
            "total_failures": self.total_failures,
            "total_successes": self.total_successes,
            "state_changes": self.state_changes,
            "last_state_change": self.last_state_change.isoformat() if self.last_state_change else None,
        }


class CircuitBreaker:
    """
    Decorator-based circuit breaker for production resilience.

    Protects against cascading failures by:
    1. Tracking failures
    2. Opening circuit when threshold exceeded
    3. Rejecting calls while open
    4. Testing recovery in half-open state
    """

    def __init__(
        self,
        name: str = "default",
        failure_threshold: int = 5,
        recovery_timeout_seconds: int = 60,
        half_open_max_calls: int = 1,
        expected_exception: type[Exception] = Exception,
        success_threshold: int = 1,
        timeout_seconds: float = 60.0,
    ) -> None:
        self.name = name
        self.failure_threshold = max(1, failure_threshold)
        self.recovery_timeout = timedelta(seconds=max(1, int(timeout_seconds if timeout_seconds != 60.0 else recovery_timeout_seconds)))
        self.half_open_max_calls = max(1, half_open_max_calls)
        self.expected_exception = expected_exception
        self.success_threshold = max(1, success_threshold)

        self.state = CircuitState.CLOSED
        self.failure_count = 0
        self.success_count = 0
        self.last_failure_time: Optional[datetime] = None
        self.last_exception: Optional[Exception] = None
        self.metrics = CircuitBreakerMetrics()

        self._lock = asyncio.Lock()

    async def call(
        self,
        func: Callable[..., Awaitable[T]],
        *args: Any,
        **kwargs: Any,
    ) -> T:
        """Execute function with circuit breaker protection."""
        async with self._lock:
            self.metrics.total_calls += 1

            # Check if we should attempt recovery
            if self.state == CircuitState.OPEN:
                if self._should_attempt_reset():
                    logger.info("Circuit %s transitioning to HALF_OPEN", self.name)
                    self._transition_to(CircuitState.HALF_OPEN)
                else:
                    raise CircuitBreakerError(
                        f"Circuit {self.name} is OPEN. "
                        f"Last failure: {self.last_exception}"
                    )

            # In half-open, limit calls
            if self.state == CircuitState.HALF_OPEN:
                if self.success_count >= self.half_open_max_calls:
                    raise CircuitBreakerError(
                        f"Circuit {self.name} is HALF_OPEN with max calls reached"
                    )

        try:
            result = await func(*args, **kwargs)
            await self._on_success()
            return result
        except self.expected_exception as e:
            await self._on_failure(e)
            raise

    async def _on_success(self) -> None:
        """Handle successful call."""
        async with self._lock:
            self.metrics.total_successes += 1
            self.failure_count = 0
            self.success_count += 1

            if self.state == CircuitState.HALF_OPEN and self.success_count >= self.success_threshold:
                logger.info("Circuit %s recovered, closing circuit", self.name)
                self._transition_to(CircuitState.CLOSED)
            elif self.state == CircuitState.CLOSED:
                self.success_count = 0

    async def _on_failure(self, exc: Exception) -> None:
        """Handle failed call."""
        async with self._lock:
            self.metrics.total_failures += 1
            self.failure_count += 1
            self.last_failure_time = datetime.now(timezone.utc)
            self.last_exception = exc
            self.success_count = 0

            logger.warning(
                "Circuit %s failure #%d/%d: %s",
                self.name, self.failure_count, self.failure_threshold, exc
            )

            if self.failure_count >= self.failure_threshold:
                logger.error("Circuit %s opening after %d failures", self.name, self.failure_count)
                self._transition_to(CircuitState.OPEN)
            elif self.state == CircuitState.HALF_OPEN:
                logger.info("Circuit %s failed recovery, reopening", self.name)
                self._transition_to(CircuitState.OPEN)

    def _should_attempt_reset(self) -> bool:
        """Check if enough time has passed to attempt recovery."""
        return (
            self.last_failure_time is not None
            and datetime.now(timezone.utc) - self.last_failure_time > self.recovery_timeout
        )

    def _transition_to(self, new_state: CircuitState) -> None:
        """Transition to new state."""
        if new_state != self.state:
            old_state = self.state
            self.state = new_state
            self.metrics.state_changes += 1
            self.metrics.last_state_change = datetime.now(timezone.utc)

            if new_state == CircuitState.HALF_OPEN:
                self.success_count = 0

            logger.info("Circuit %s: %s → %s", self.name, old_state.value, new_state.value)

    def get_state(self) -> CircuitState:
        """Get current circuit state."""
        return self.state

    def get_metrics(self) -> dict[str, Any]:
        """Get circuit metrics."""
        return {
            "name": self.name,
            "state": self.state.value,
            "failure_count": self.failure_count,
            "success_count": self.success_count,
            "last_failure": self.last_failure_time.isoformat() if self.last_failure_time else None,
            "last_exception": str(self.last_exception) if self.last_exception else None,
            **self.metrics.to_dict()
        }

    def reset(self) -> None:
        """Manually reset circuit."""
        self.state = CircuitState.CLOSED
        self.failure_count = 0
        self.success_count = 0
        logger.info("Circuit %s manually reset", self.name)


class CircuitBreakerRegistry:
    """
    Centralized registry of all circuit breakers.
    Useful for monitoring and coordination.
    """

    def __init__(self) -> None:
        self._breakers: dict[str, CircuitBreaker] = {}
        self._lock = asyncio.Lock()

    async def register(self, breaker: CircuitBreaker) -> None:
        """Register a circuit breaker."""
        async with self._lock:
            if breaker.name in self._breakers:
                logger.warning("Circuit breaker %s already registered", breaker.name)
            self._breakers[breaker.name] = breaker

    async def get(self, name: str) -> Optional[CircuitBreaker]:
        """Get a registered circuit breaker."""
        return self._breakers.get(name)

    async def get_all_metrics(self) -> dict[str, dict[str, Any]]:
        """Get metrics for all registered breakers."""
        return {
            name: breaker.get_metrics()
            for name, breaker in self._breakers.items()
        }

    async def reset_all(self) -> None:
        """Reset all circuit breakers."""
        for breaker in self._breakers.values():
            breaker.reset()
        logger.info("All circuit breakers reset")


_global_registry = CircuitBreakerRegistry()


async def get_circuit_breaker_registry() -> CircuitBreakerRegistry:
    """Get global circuit breaker registry."""
    return _global_registry


def circuit_breaker(
    name_or_breaker: str | CircuitBreaker,
    failure_threshold: int = 5,
    recovery_timeout_seconds: int = 60,
    half_open_max_calls: int = 1,
) -> Callable[[Callable[..., Awaitable[T]]], Callable[..., Awaitable[T]]]:
    if isinstance(name_or_breaker, CircuitBreaker):
        breaker = name_or_breaker
    else:
        breaker = CircuitBreaker(
            name_or_breaker,
            failure_threshold=failure_threshold,
            recovery_timeout_seconds=recovery_timeout_seconds,
            half_open_max_calls=half_open_max_calls,
        )

    def decorator(func: Callable[..., Awaitable[T]]) -> Callable[..., Awaitable[T]]:
        @wraps(func)
        async def wrapper(*args: Any, **kwargs: Any) -> T:
            return await breaker.call(func, *args, **kwargs)

        wrapper._circuit_breaker = breaker  # type: ignore
        return wrapper

    return decorator


# ═══════════════════════════════════════════════════════════════
# Simple Provider Circuit Cool-down Helpers
# ═══════════════════════════════════════════════════════════════

_CIRCUIT_BREAKER_TTL_SECONDS = 60.0
_provider_failures: dict[str, float] = {}


def circuit_open(provider_name: str, ttl_seconds: float = _CIRCUIT_BREAKER_TTL_SECONDS) -> bool:
    """Return whether a provider is temporarily excluded after a hard failure."""
    clean = str(provider_name or "").strip().lower()
    failed_at = _provider_failures.get(clean)
    if failed_at is None:
        return False
    if time.monotonic() - failed_at >= ttl_seconds:
        _provider_failures.pop(clean, None)
        return False
    return True


def trip_circuit(provider_name: str, ttl_seconds: float = _CIRCUIT_BREAKER_TTL_SECONDS) -> None:
    """Open a provider circuit for a bounded cool-down period."""
    clean = str(provider_name or "").strip().lower()
    if not clean:
        return
    _provider_failures[clean] = time.monotonic()
    logger.info("Provider circuit opened provider=%s cooldown_seconds=%d", clean, int(ttl_seconds))


def reset_circuits_for_tests() -> None:
    """Reset provider failures dict for test isolation."""
    _provider_failures.clear()
