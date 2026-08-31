"""Compatibility aliases for LLM utilities.

Direct provider generation was intentionally removed from this module. All LLM
operations must flow through ``ServiceContainer.llm`` so pooling, fallback,
tracing, timeouts, and billing controls cannot be bypassed.
"""

from __future__ import annotations

from backend.services.core.circuit_breaker import CircuitBreaker, CircuitBreakerError

__all__ = ["CircuitBreaker", "CircuitBreakerError"]
