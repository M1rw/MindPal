"""Compatibility aliases for the centralized provider circuit breaker.

Direct provider generation was intentionally removed from this module. All LLM
operations must flow through ``ServiceContainer.llm`` so pooling, fallback,
tracing, timeouts, and billing controls cannot be bypassed.
"""

from backend.core.circuit_breaker import circuit_open as _circuit_open
from backend.core.circuit_breaker import trip_circuit as _trip_circuit

__all__ = ["_circuit_open", "_trip_circuit"]
