# backend/services/core/provider_reliability.py
"""
Provider reliability hardening with exponential backoff and circuit breaking.

Implements production-grade resilience patterns:
- Exponential backoff with jitter to prevent thundering herd
- Consistent circuit breaker state management
- Automatic recovery with half-open probing
- Cost-aware retry decisions (don't retry on 402, do retry on 429)
- Request context propagation for observability

This module decouples reliability logic from service logic,
making it testable and reusable across all providers.
"""

from __future__ import annotations

import asyncio
import logging
import random
from dataclasses import dataclass
from datetime import datetime, UTC, timedelta
from enum import Enum
from typing import Any, Callable, Optional, TypeVar

from backend.core.errors import ProviderError, ProviderTimeoutError
from backend.services.core.request_tracing import RequestTracer

logger = logging.getLogger(__name__)

T = TypeVar('T')


class CircuitState(Enum):
    """Circuit breaker finite state machine."""
    CLOSED = "closed"              # Normal operation
    OPEN = "open"                  # Failing, reject requests
    HALF_OPEN = "half_open"        # Testing recovery


@dataclass(slots=True, frozen=True)
class CircuitBreakerState:
    """Snapshot of circuit breaker state."""
    state: CircuitState
    failure_count: int
    success_count: int
    last_failure_at: datetime | None
    opened_at: datetime | None
    
    @property
    def is_closed(self) -> bool:
        return self.state == CircuitState.CLOSED
    
    @property
    def is_open(self) -> bool:
        return self.state == CircuitState.OPEN
    
    @property
    def is_half_open(self) -> bool:
        return self.state == CircuitState.HALF_OPEN


class CircuitBreaker:
    """
    Production-grade circuit breaker for provider calls.
    
    States:
      CLOSED (normal)
        └─ failures accumulate
        └─ threshold exceeded → OPEN
      
      OPEN (failing)
        └─ all requests rejected
        └─ timeout elapsed → HALF_OPEN
      
      HALF_OPEN (testing recovery)
        └─ limited requests allowed
        └─ all succeed → CLOSED
        └─ any failure → OPEN (restart timeout)
    """

    def __init__(
        self,
        name: str,
        *,
        failure_threshold: int = 5,
        recovery_timeout_seconds: float = 60.0,
        half_open_max_requests: int = 3,
    ) -> None:
        self.name = name
        self.failure_threshold = failure_threshold
        self.recovery_timeout_seconds = recovery_timeout_seconds
        self.half_open_max_requests = half_open_max_requests
        
        self._state = CircuitState.CLOSED
        self._failure_count = 0
        self._success_count = 0
        self._last_failure_at: datetime | None = None
        self._opened_at: datetime | None = None
        self._lock = asyncio.Lock()

    def get_state(self) -> CircuitBreakerState:
        """Get snapshot of current state."""
        return CircuitBreakerState(
            state=self._state,
            failure_count=self._failure_count,
            success_count=self._success_count,
            last_failure_at=self._last_failure_at,
            opened_at=self._opened_at,
        )

    async def can_execute(self) -> bool:
        """Check if a request can proceed."""
        async with self._lock:
            if self._state == CircuitState.CLOSED:
                return True
            
            if self._state == CircuitState.OPEN:
                # Check if timeout has elapsed
                if self._opened_at is None:
                    return False
                
                elapsed = datetime.now(UTC) - self._opened_at
                if elapsed.total_seconds() >= self.recovery_timeout_seconds:
                    logger.info(
                        "Circuit breaker %s: timeout elapsed, attempting recovery (HALF_OPEN)",
                        self.name,
                    )
                    self._transition_to_half_open()
                    return True
                
                return False
            
            # HALF_OPEN: allow limited requests
            if self._state == CircuitState.HALF_OPEN:
                if self._success_count >= self.half_open_max_requests:
                    # All probes succeeded, close circuit
                    logger.info(
                        "Circuit breaker %s: recovery successful (CLOSED)",
                        self.name,
                    )
                    self._transition_to_closed()
                    return True
                
                return True
            
            return False

    async def record_success(self) -> None:
        """Record a successful call."""
        async with self._lock:
            if self._state == CircuitState.HALF_OPEN:
                self._success_count += 1
                logger.debug(
                    "Circuit breaker %s: probe success (%d/%d)",
                    self.name,
                    self._success_count,
                    self.half_open_max_requests,
                )
            elif self._state == CircuitState.CLOSED:
                # Reset failure count on success
                if self._failure_count > 0:
                    logger.debug(
                        "Circuit breaker %s: success, failure count reset",
                        self.name,
                    )
                    self._failure_count = 0

    async def record_failure(self, error_code: str | None = None) -> None:
        """
        Record a failed call.
        
        Some failures should NOT increment the counter:
        - 429 (rate limited) - provider is temporarily overloaded
        - 402 (payment required) - billing issue, try different provider
        - 401/403 (auth) - configuration error, don't retry
        """
        async with self._lock:
            # Don't trip circuit for auth errors (configuration issue)
            if error_code in ("401", "403", "auth_error"):
                logger.debug(
                    "Circuit breaker %s: auth error (not counted as failure)",
                    self.name,
                )
                return
            
            self._failure_count += 1
            self._last_failure_at = datetime.now(UTC)
            
            logger.debug(
                "Circuit breaker %s: failure recorded (%d/%d)",
                self.name,
                self._failure_count,
                self.failure_threshold,
            )
            
            # Check threshold
            if self._failure_count >= self.failure_threshold:
                if self._state != CircuitState.OPEN:
                    logger.warning(
                        "Circuit breaker %s: threshold exceeded, opening circuit (error=%s)",
                        self.name,
                        error_code,
                    )
                    self._transition_to_open()

    async def reset(self) -> None:
        """Force circuit closed (for testing or manual recovery)."""
        async with self._lock:
            self._transition_to_closed()

    def _transition_to_closed(self) -> None:
        """Transition HALF_OPEN or OPEN → CLOSED."""
        self._state = CircuitState.CLOSED
        self._failure_count = 0
        self._success_count = 0
        self._opened_at = None

    def _transition_to_open(self) -> None:
        """Transition CLOSED or HALF_OPEN → OPEN."""
        self._state = CircuitState.OPEN
        self._success_count = 0
        self._opened_at = datetime.now(UTC)

    def _transition_to_half_open(self) -> None:
        """Transition OPEN → HALF_OPEN."""
        self._state = CircuitState.HALF_OPEN
        self._failure_count = 0
        self._success_count = 0


class BackoffStrategy:
    """
    Exponential backoff with jitter and max backoff cap.
    
    Implements:
    - Exponential: backoff = base * (multiplier ^ attempt)
    - Jitter: ±variance to prevent thundering herd
    - Cap: max_backoff_ms prevents excessive delays
    """

    def __init__(
        self,
        initial_backoff_ms: float = 100.0,
        max_backoff_ms: float = 10_000.0,
        multiplier: float = 2.0,
        jitter_factor: float = 0.1,
    ) -> None:
        self.initial_backoff_ms = initial_backoff_ms
        self.max_backoff_ms = max_backoff_ms
        self.multiplier = multiplier
        self.jitter_factor = jitter_factor

    def get_backoff_ms(self, attempt: int) -> float:
        """
        Get backoff duration for nth attempt (0-indexed).
        
        Example (2x multiplier, 100ms initial, ±10% jitter):
          attempt 0: 0ms (first request)
          attempt 1: 100ms ± 10ms
          attempt 2: 200ms ± 20ms
          attempt 3: 400ms ± 40ms (capped at max_backoff_ms)
        """
        if attempt <= 0:
            return 0.0
        
        # Calculate exponential backoff
        backoff = self.initial_backoff_ms * (self.multiplier ** (attempt - 1))
        backoff = min(backoff, self.max_backoff_ms)
        
        # Add jitter
        variance = backoff * self.jitter_factor
        jitter = random.uniform(-variance, variance)
        
        result = max(0.0, backoff + jitter)
        return result

    async def wait(self, attempt: int) -> None:
        """Wait for calculated backoff duration."""
        backoff = self.get_backoff_ms(attempt)
        if backoff > 0:
            await asyncio.sleep(backoff / 1000.0)


# ═══════════════════════════════════════════════════════════════
# Retry Policy Executor
# ═══════════════════════════════════════════════════════════════

@dataclass(slots=True, frozen=True)
class RetryDecision:
    """Decision on whether to retry a failed operation."""
    should_retry: bool
    reason: str
    backoff_ms: float = 0.0


def _should_retry_error(error: Exception, status_code: str | None = None) -> bool:
    """
    Determine if an error is retryable.
    
    Retryable:
    - 429 (rate limited)
    - 500+ (server error)
    - Timeout
    
    Not retryable:
    - 400, 401, 403 (client error, auth)
    - 402 (payment required - switch provider, don't retry)
    """
    # Auth errors - not retryable
    if status_code in ("401", "403"):
        return False
    
    # Payment required - not retryable (switch provider instead)
    if status_code == "402":
        return False
    
    # Rate limited - retryable
    if status_code == "429":
        return True
    
    # Server error - retryable
    if status_code and status_code.startswith("5"):
        return True
    
    # Timeout - retryable
    if isinstance(error, (asyncio.TimeoutError, ProviderTimeoutError)):
        return True
    
    return False


class RetryExecutor:
    """
    Executes operations with retry logic, backoff, and circuit breaking.
    """

    def __init__(
        self,
        max_retries: int = 3,
        backoff_strategy: BackoffStrategy | None = None,
        circuit_breaker: CircuitBreaker | None = None,
    ) -> None:
        self.max_retries = max_retries
        self.backoff_strategy = backoff_strategy or BackoffStrategy()
        self.circuit_breaker = circuit_breaker

    async def execute(
        self,
        operation: Callable[..., T],
        *,
        operation_name: str = "unknown",
        **kwargs: Any,
    ) -> T:
        """
        Execute an operation with retry logic.
        
        Args:
            operation: Async function to execute
            operation_name: Name for logging
            **kwargs: Arguments to pass to operation
            
        Returns:
            Result of successful operation
            
        Raises:
            ProviderError: If all retries exhausted
        """
        
        # Check circuit breaker
        if self.circuit_breaker:
            if not await self.circuit_breaker.can_execute():
                raise ProviderError(
                    f"Circuit breaker open for {operation_name}",
                    code="circuit_breaker_open",
                )
        
        last_error: Exception | None = None
        
        for attempt in range(self.max_retries + 1):
            try:
                result = await operation(**kwargs)
                
                # Success - record with circuit breaker
                if self.circuit_breaker:
                    await self.circuit_breaker.record_success()
                
                # Record in trace
                RequestTracer.record_provider_call(
                    provider_name=operation_name,
                    status="success",
                    metadata={"attempt": attempt},
                )
                
                return result
            
            except Exception as e:
                last_error = e
                error_code = getattr(e, 'code', None)
                status_code = str(getattr(e, 'status_code', ''))
                
                # Record with circuit breaker
                if self.circuit_breaker:
                    await self.circuit_breaker.record_failure(status_code)
                
                # Determine if retryable
                if not _should_retry_error(e, status_code):
                    logger.info(
                        "%s failed (attempt %d) with non-retryable error: %s",
                        operation_name,
                        attempt,
                        error_code or str(e),
                    )
                    raise
                
                # Last attempt?
                if attempt >= self.max_retries:
                    logger.warning(
                        "%s: all %d retries exhausted",
                        operation_name,
                        self.max_retries,
                    )
                    raise
                
                # Wait before retry
                backoff = self.backoff_strategy.get_backoff_ms(attempt + 1)
                logger.debug(
                    "%s: retry attempt %d after %.0fms (error: %s)",
                    operation_name,
                    attempt + 1,
                    backoff,
                    error_code or str(e),
                )
                
                await self.backoff_strategy.wait(attempt + 1)
        
        raise last_error or ProviderError("Operation failed")


# ═══════════════════════════════════════════════════════════════
# Provider Reliability Manager (Centralized)
# ═══════════════════════════════════════════════════════════════

class ProviderReliabilityManager:
    """
    Centralized management of circuit breakers and retry policies for all providers.
    """

    def __init__(self) -> None:
        self._circuit_breakers: dict[str, CircuitBreaker] = {}
        self._retry_executors: dict[str, RetryExecutor] = {}

    def register_provider(
        self,
        provider_name: str,
        failure_threshold: int = 5,
        recovery_timeout_seconds: float = 60.0,
        max_retries: int = 3,
    ) -> None:
        """Register a provider with its reliability settings."""
        
        circuit_breaker = CircuitBreaker(
            name=provider_name,
            failure_threshold=failure_threshold,
            recovery_timeout_seconds=recovery_timeout_seconds,
        )
        
        backoff = BackoffStrategy()
        retry_executor = RetryExecutor(
            max_retries=max_retries,
            backoff_strategy=backoff,
            circuit_breaker=circuit_breaker,
        )
        
        self._circuit_breakers[provider_name] = circuit_breaker
        self._retry_executors[provider_name] = retry_executor
        
        logger.info(
            "Registered provider: %s (failures_threshold=%d, timeout=%s, max_retries=%d)",
            provider_name,
            failure_threshold,
            recovery_timeout_seconds,
            max_retries,
        )

    def get_circuit_breaker(self, provider_name: str) -> CircuitBreaker | None:
        """Get circuit breaker for provider."""
        return self._circuit_breakers.get(provider_name)

    def get_retry_executor(self, provider_name: str) -> RetryExecutor | None:
        """Get retry executor for provider."""
        return self._retry_executors.get(provider_name)

    async def execute_with_reliability(
        self,
        provider_name: str,
        operation: Callable[..., T],
        **kwargs: Any,
    ) -> T:
        """
        Execute operation with full reliability hardening:
        - Circuit breaker checks
        - Exponential backoff retries
        - Request tracing
        """
        executor = self.get_retry_executor(provider_name)
        if not executor:
            raise ValueError(f"Provider {provider_name} not registered")
        
        return await executor.execute(
            operation,
            operation_name=provider_name,
            **kwargs,
        )

    def get_provider_health(self, provider_name: str) -> dict[str, Any]:
        """Get health status of a provider."""
        breaker = self.get_circuit_breaker(provider_name)
        if not breaker:
            return {"status": "unknown"}
        
        state = breaker.get_state()
        return {
            "circuit_state": state.state.value,
            "failure_count": state.failure_count,
            "success_count": state.success_count,
            "last_failure": state.last_failure_at.isoformat() if state.last_failure_at else None,
            "is_available": state.is_closed or state.is_half_open,
        }

    def get_all_providers_health(self) -> dict[str, Any]:
        """Get health status of all providers."""
        return {
            provider: self.get_provider_health(provider)
            for provider in self._circuit_breakers.keys()
        }


# Global reliability manager singleton
_global_reliability_manager: ProviderReliabilityManager | None = None


def get_global_reliability_manager() -> ProviderReliabilityManager:
    """Get or create the global reliability manager."""
    global _global_reliability_manager
    if _global_reliability_manager is None:
        _global_reliability_manager = ProviderReliabilityManager()
    return _global_reliability_manager
