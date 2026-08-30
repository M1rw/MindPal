# Enhanced Circuit Breaker Pattern

from enum import Enum
from datetime import datetime, timedelta
from functools import wraps
from typing import Awaitable, Callable, Optional, TypeVar, Any
import asyncio
import logging

logger = logging.getLogger(__name__)

T = TypeVar('T')


class CircuitState(Enum):
    """States of the circuit breaker."""
    CLOSED = "closed"          # Normal operation, calls pass through
    OPEN = "open"              # Failing, calls are rejected
    HALF_OPEN = "half_open"    # Testing if recovered, limited calls allowed


class CircuitBreakerError(Exception):
    """Raised when circuit breaker is OPEN."""
    pass


class CircuitBreakerMetrics:
    """Metrics collected by circuit breaker."""
    
    def __init__(self):
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
    
    Usage:
        @circuit_breaker("external_api", failure_threshold=5, recovery_timeout=60)
        async def call_external_api(url: str) -> dict:
            # ... actual call
            pass
    """
    
    def __init__(
        self,
        name: str,
        failure_threshold: int = 5,
        recovery_timeout_seconds: int = 60,
        half_open_max_calls: int = 1,
        expected_exception: type[Exception] = Exception,
    ):
        """
        Initialize circuit breaker.
        
        Args:
            name: Circuit name (for logging/monitoring)
            failure_threshold: # failures before opening circuit
            recovery_timeout_seconds: Wait time before attempting recovery
            half_open_max_calls: # calls allowed in half-open state
            expected_exception: Exception type to catch (or tuple of types)
        """
        self.name = name
        self.failure_threshold = max(1, failure_threshold)
        self.recovery_timeout = timedelta(seconds=max(1, recovery_timeout_seconds))
        self.half_open_max_calls = max(1, half_open_max_calls)
        self.expected_exception = expected_exception
        
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
        *args,
        **kwargs
    ) -> T:
        """
        Execute function with circuit breaker protection.
        
        Args:
            func: Async function to call
            *args: Function positional arguments
            **kwargs: Function keyword arguments
            
        Returns:
            Function return value
            
        Raises:
            CircuitBreakerError: If circuit is OPEN
            Exception: Original exception from func
        """
        async with self._lock:
            self.metrics.total_calls += 1
            
            # Check if we should attempt recovery
            if self.state == CircuitState.OPEN:
                if self._should_attempt_reset():
                    logger.info(f"Circuit {self.name} transitioning to HALF_OPEN")
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
            
            if self.state == CircuitState.HALF_OPEN:
                logger.info(f"Circuit {self.name} recovered, closing circuit")
                self._transition_to(CircuitState.CLOSED)
            elif self.state == CircuitState.CLOSED:
                self.success_count = 0
    
    async def _on_failure(self, exc: Exception) -> None:
        """Handle failed call."""
        async with self._lock:
            self.metrics.total_failures += 1
            self.failure_count += 1
            self.last_failure_time = datetime.utcnow()
            self.last_exception = exc
            self.success_count = 0
            
            logger.warning(
                f"Circuit {self.name} failure #{self.failure_count}/{self.failure_threshold}: {exc}"
            )
            
            if self.failure_count >= self.failure_threshold:
                logger.error(f"Circuit {self.name} opening after {self.failure_count} failures")
                self._transition_to(CircuitState.OPEN)
            elif self.state == CircuitState.HALF_OPEN:
                logger.info(f"Circuit {self.name} failed recovery, reopening")
                self._transition_to(CircuitState.OPEN)
    
    def _should_attempt_reset(self) -> bool:
        """Check if enough time has passed to attempt recovery."""
        return (
            self.last_failure_time is not None
            and datetime.utcnow() - self.last_failure_time > self.recovery_timeout
        )
    
    def _transition_to(self, new_state: CircuitState) -> None:
        """Transition to new state."""
        if new_state != self.state:
            old_state = self.state
            self.state = new_state
            self.metrics.state_changes += 1
            self.metrics.last_state_change = datetime.utcnow()
            
            # Reset counters for new state
            if new_state == CircuitState.HALF_OPEN:
                self.success_count = 0
            
            logger.info(f"Circuit {self.name}: {old_state.value} → {new_state.value}")
    
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
        logger.info(f"Circuit {self.name} manually reset")


class CircuitBreakerRegistry:
    """
    Centralized registry of all circuit breakers.
    Useful for monitoring and coordination.
    """
    
    def __init__(self):
        self._breakers: dict[str, CircuitBreaker] = {}
        self._lock = asyncio.Lock()
    
    async def register(self, breaker: CircuitBreaker) -> None:
        """Register a circuit breaker."""
        async with self._lock:
            if breaker.name in self._breakers:
                logger.warning(f"Circuit breaker {breaker.name} already registered")
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


# Global registry
_global_registry = CircuitBreakerRegistry()


async def get_circuit_breaker_registry() -> CircuitBreakerRegistry:
    """Get global circuit breaker registry."""
    return _global_registry


def circuit_breaker(
    name: str,
    failure_threshold: int = 5,
    recovery_timeout_seconds: int = 60,
    half_open_max_calls: int = 1,
) -> Callable[[Callable[..., Awaitable[T]]], Callable[..., Awaitable[T]]]:
    """
    Decorator for adding circuit breaker protection.
    
    Args:
        name: Circuit name
        failure_threshold: Failures before opening
        recovery_timeout_seconds: Recovery wait time
        half_open_max_calls: Calls allowed in half-open state
        
    Returns:
        Decorated function with circuit breaker
        
    Example:
        @circuit_breaker("external_api", failure_threshold=5)
        async def call_api() -> dict:
            return await external_service.get_data()
    """
    breaker = CircuitBreaker(
        name,
        failure_threshold=failure_threshold,
        recovery_timeout_seconds=recovery_timeout_seconds,
        half_open_max_calls=half_open_max_calls,
    )
    
    def decorator(func: Callable[..., Awaitable[T]]) -> Callable[..., Awaitable[T]]:
        @wraps(func)
        async def wrapper(*args, **kwargs) -> T:
            return await breaker.call(func, *args, **kwargs)
        
        # Store reference for monitoring
        wrapper._circuit_breaker = breaker  # type: ignore
        return wrapper
    
    return decorator

