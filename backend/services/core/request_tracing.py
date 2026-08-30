# backend/services/core/request_tracing.py
"""
Request-scoped tracing and observability infrastructure.

Provides correlation IDs and structured logging for:
- Every HTTP request
- Every provider call
- Every service boundary
- Every database operation

This enables:
- End-to-end request tracing
- Performance debugging
- Cost attribution
- User experience monitoring
"""

from __future__ import annotations

import contextvars
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, UTC
from typing import Any, Optional
from uuid import uuid4

from backend.core.config import get_settings
from backend.services.core.metrics import record_provider_request, record_service_request
from backend.services.core.provider_policy import RequestClass

try:
    from opentelemetry import trace as otel_trace
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor, ConsoleSpanExporter
    from opentelemetry.trace import Span
except Exception:  # pragma: no cover - optional dependency path
    otel_trace = None
    Resource = None
    TracerProvider = None
    BatchSpanProcessor = None
    ConsoleSpanExporter = None
    Span = Any  # type: ignore[assignment]

logger = logging.getLogger(__name__)

_OTEL_TRACER = None
_OTEL_PROVIDER = None
_OTEL_READY = False


def _maybe_init_otel() -> None:
    """Configure optional OpenTelemetry tracing when enabled."""
    global _OTEL_TRACER, _OTEL_PROVIDER, _OTEL_READY

    if otel_trace is None or _OTEL_READY:
        return

    try:
        settings = get_settings()
        if not bool(getattr(settings, "OTEL_ENABLED", False)):
            _OTEL_READY = True
            return
    except Exception:
        _OTEL_READY = True
        return

    try:
        service_name = str(getattr(settings, "OTEL_SERVICE_NAME", "mindpal-backend")).strip() or "mindpal-backend"
        resource = Resource.create({"service.name": service_name, "service.namespace": "mindpal"})
        provider = TracerProvider(resource=resource)
        provider.add_span_processor(BatchSpanProcessor(ConsoleSpanExporter()))
        try:
            otel_trace.set_tracer_provider(provider)
        except Exception:
            pass
        _OTEL_PROVIDER = provider
        _OTEL_TRACER = otel_trace.get_tracer(service_name)
        _OTEL_READY = True
    except Exception:
        _OTEL_READY = True
        _OTEL_TRACER = None
        _OTEL_PROVIDER = None


def _get_otel_tracer() -> Any | None:
    _maybe_init_otel()
    return _OTEL_TRACER


# Context variable for request ID propagation across async boundaries
_request_id_context: contextvars.ContextVar[str] = contextvars.ContextVar(
    "request_id",
    default=""
)

_trace_context: contextvars.ContextVar[RequestTrace | None] = contextvars.ContextVar(
    "request_trace",
    default=None
)


@dataclass(slots=True)
class ProviderCallSpan:
    """A single provider API call within a request."""
    provider_name: str
    model_name: str | None = None
    operation: str = "generate"  # "generate", "embed", "stream"
    status: str = "pending"       # "pending", "success", "failure", "timeout"
    
    # Timing
    start_time_ms: float = field(default_factory=lambda: time.time_ns() / 1e6)
    end_time_ms: float | None = None
    
    # Tokens (for cost tracking)
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    
    # Error tracking
    error_code: str | None = None
    error_message: str | None = None
    
    # Metadata (safe to log)
    metadata: dict[str, Any] = field(default_factory=dict)
    
    @property
    def duration_ms(self) -> float:
        """Get duration in milliseconds."""
        if self.end_time_ms is None:
            return time.time_ns() / 1e6 - self.start_time_ms
        return self.end_time_ms - self.start_time_ms
    
    @property
    def total_tokens(self) -> int | None:
        """Get total tokens (prompt + completion)."""
        if self.prompt_tokens is None or self.completion_tokens is None:
            return None
        return self.prompt_tokens + self.completion_tokens
    
    @property
    def estimated_cost_cents(self) -> float:
        """Estimate cost of this call (stub - override in policy)."""
        # This would use provider cost models
        return 0.0
    
    def to_dict(self) -> dict[str, Any]:
        """Export for logging (redacted)."""
        return {
            "provider": self.provider_name,
            "model": self.model_name,
            "operation": self.operation,
            "status": self.status,
            "duration_ms": self.duration_ms,
            "tokens": self.total_tokens,
            "error_code": self.error_code,
        }


@dataclass(slots=True)
class ServiceCallSpan:
    """A service-to-service call within a request."""
    from_service: str
    to_service: str
    operation: str  # e.g., "generate", "classify", "retrieve"
    status: str = "pending"
    
    start_time_ms: float = field(default_factory=lambda: time.time_ns() / 1e6)
    end_time_ms: float | None = None
    
    error_code: str | None = None
    
    @property
    def duration_ms(self) -> float:
        if self.end_time_ms is None:
            return time.time_ns() / 1e6 - self.start_time_ms
        return self.end_time_ms - self.start_time_ms
    
    def to_dict(self) -> dict[str, Any]:
        return {
            "from": self.from_service,
            "to": self.to_service,
            "operation": self.operation,
            "status": self.status,
            "duration_ms": self.duration_ms,
            "error_code": self.error_code,
        }


@dataclass(slots=True)
class RequestTrace:
    """
    Complete trace for a single HTTP request or CLI operation.
    
    Tracks:
    - Request metadata (ID, user, timestamp)
    - All provider calls
    - All service-to-service calls
    - Timing, costs, errors
    """
    request_id: str
    user_id_hash: str | None = None
    channel: str = "unknown"  # "web", "mobile", "cli"
    operation: str = "unknown"
    otel_trace_id: str | None = None
    otel_span_id: str | None = None
    otel_span: Any | None = field(default=None, repr=False)
    
    # Timing
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    
    # Traces
    provider_calls: list[ProviderCallSpan] = field(default_factory=list)
    service_calls: list[ServiceCallSpan] = field(default_factory=list)
    
    # Aggregate metrics
    total_tokens_used: int = 0
    total_cost_cents: float = 0.0
    
    # Status
    status: str = "pending"  # "pending", "success", "failure"
    error_code: str | None = None
    
    @property
    def duration_ms(self) -> float:
        """Total request duration."""
        return (datetime.now(UTC) - self.started_at).total_seconds() * 1000
    
    def add_provider_call(self, span: ProviderCallSpan) -> None:
        """Record a provider API call."""
        self.provider_calls.append(span)
    
    def add_service_call(self, span: ServiceCallSpan) -> None:
        """Record a service-to-service call."""
        self.service_calls.append(span)
    
    def mark_success(self) -> None:
        """Mark request as successful."""
        self.status = "success"
    
    def mark_failure(self, error_code: str | None = None) -> None:
        """Mark request as failed."""
        self.status = "failure"
        self.error_code = error_code
    
    def to_dict(self) -> dict[str, Any]:
        """Export trace for logging (redacted)."""
        return {
            "request_id": self.request_id,
            "user_id_hash": self.user_id_hash,
            "channel": self.channel,
            "operation": self.operation,
            "status": self.status,
            "duration_ms": self.duration_ms,
            "provider_calls": [call.to_dict() for call in self.provider_calls],
            "service_calls": [call.to_dict() for call in self.service_calls],
            "tokens": self.total_tokens_used,
            "cost_cents": self.total_cost_cents,
            "error_code": self.error_code,
        }


class RequestTracer:
    """
    Context-aware request tracer.
    
    Manages request-scoped tracing across async operations.
    """

    @staticmethod
    def start_request(
        request_id: str | None = None,
        user_id_hash: str | None = None,
        channel: str = "web",
        operation: str = "unknown",
    ) -> RequestTrace:
        """
        Start tracing a request.
        
        Args:
            request_id: Unique request ID (generated if not provided)
            user_id_hash: Hashed user ID for attribution (no PII)
            channel: "web", "mobile", "cli"
            operation: Operation name (route, command, job)
            
        Returns:
            RequestTrace instance
        """
        request_id = request_id or str(uuid4())
        
        trace = RequestTrace(
            request_id=request_id,
            user_id_hash=user_id_hash,
            channel=channel,
            operation=operation,
        )

        tracer = _get_otel_tracer()
        if tracer is not None:
            span = tracer.start_span(
                "mindpal.request",
                attributes={
                    "mindpal.request_id": request_id,
                    "mindpal.operation": operation,
                    "mindpal.channel": channel,
                    "mindpal.user_id_hash": user_id_hash or "anonymous",
                },
            )
            trace.otel_span = span
            trace_context = span.get_span_context()
            trace.otel_trace_id = format(trace_context.trace_id, "032x")
            trace.otel_span_id = format(trace_context.span_id, "016x")

        # Set context for access from any async function
        _request_id_context.set(request_id)
        _trace_context.set(trace)
        
        logger.debug(
            "Tracing request: %s (operation=%s, user=%s)",
            request_id,
            operation,
            user_id_hash,
        )
        
        return trace

    @staticmethod
    def get_current_request_id() -> str:
        """Get current request ID from context."""
        return _request_id_context.get()

    @staticmethod
    def get_current_trace() -> RequestTrace | None:
        """Get current request trace from context."""
        return _trace_context.get()

    @staticmethod
    def record_provider_call(
        provider_name: str,
        model_name: str | None = None,
        operation: str = "generate",
        status: str = "success",
        prompt_tokens: int | None = None,
        completion_tokens: int | None = None,
        error_code: str | None = None,
        **metadata: Any
    ) -> None:
        """
        Record a provider API call.
        
        Safe for logging: does not include prompt/response content.
        """
        trace = RequestTracer.get_current_trace()
        if trace is None:
            return
        
        span = ProviderCallSpan(
            provider_name=provider_name,
            model_name=model_name,
            operation=operation,
            status=status,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            error_code=error_code,
            metadata=metadata,
        )

        tracer = _get_otel_tracer()
        if tracer is not None:
            otel_span = tracer.start_span(
                "mindpal.provider_call",
                attributes={
                    "mindpal.provider": provider_name,
                    "mindpal.model": model_name or "unknown",
                    "mindpal.operation": operation,
                    "mindpal.status": status,
                    "mindpal.prompt_tokens": int(prompt_tokens or 0),
                    "mindpal.completion_tokens": int(completion_tokens or 0),
                    "mindpal.error_code": error_code or "none",
                },
            )
            otel_span.end()

        span.end_time_ms = time.time_ns() / 1e6
        record_provider_request(provider_name, operation, span.duration_ms, status=status)
        trace.add_provider_call(span)

        if prompt_tokens and completion_tokens:
            trace.total_tokens_used += prompt_tokens + completion_tokens

    @staticmethod
    def record_service_call(
        from_service: str,
        to_service: str,
        operation: str,
        status: str = "success",
        error_code: str | None = None,
    ) -> None:
        """Record a service-to-service call."""
        trace = RequestTracer.get_current_trace()
        if trace is None:
            return
        
        span = ServiceCallSpan(
            from_service=from_service,
            to_service=to_service,
            operation=operation,
            status=status,
            error_code=error_code,
        )

        tracer = _get_otel_tracer()
        if tracer is not None:
            otel_span = tracer.start_span(
                "mindpal.service_call",
                attributes={
                    "mindpal.from_service": from_service,
                    "mindpal.to_service": to_service,
                    "mindpal.operation": operation,
                    "mindpal.status": status,
                    "mindpal.error_code": error_code or "none",
                },
            )
            otel_span.end()

        span.end_time_ms = time.time_ns() / 1e6
        record_service_request(from_service, operation, span.duration_ms, status=status)
        trace.add_service_call(span)

    @staticmethod
    def end_request(success: bool = True, error_code: str | None = None) -> RequestTrace | None:
        """
        End tracing and emit trace log.
        
        Returns:
            Completed RequestTrace for inspection
        """
        trace = RequestTracer.get_current_trace()
        if trace is None:
            return None
        
        if success:
            trace.mark_success()
        else:
            trace.mark_failure(error_code)
        
        if trace.otel_span is not None:
            try:
                trace.otel_span.end()
            except Exception:
                logger.debug("Failed to close OpenTelemetry span for request %s", trace.request_id, exc_info=True)

        # Emit trace log
        trace_dict = trace.to_dict()
        logger.info(
            "Request complete: %s (%s in %.1fms)",
            trace.request_id,
            trace.status,
            trace.duration_ms,
            extra={"trace": trace_dict},
        )
        
        # Clear context
        _request_id_context.set("")
        _trace_context.set(None)
        trace.otel_span = None
        
        return trace


# ═══════════════════════════════════════════════════════════════
# Decorators for easy instrumentation
# ═══════════════════════════════════════════════════════════════

def traced_provider_call(provider_name: str, model_name: str | None = None, operation: str = "generate"):
    """
    Decorator to trace provider calls.
    
    Example:
        @traced_provider_call("gemini", "gemini-2.0-flash-lite", "generate")
        async def my_llm_call(prompt):
            result = await llm.generate(prompt)
            return result
    """
    def decorator(func):
        import functools
        
        @functools.wraps(func)
        async def wrapper(*args, **kwargs):
            start = time.time_ns() / 1e6
            trace = RequestTracer.get_current_trace()
            
            span = ProviderCallSpan(
                provider_name=provider_name,
                model_name=model_name,
                operation=operation,
            )
            
            try:
                result = await func(*args, **kwargs)
                span.status = "success"
                
                # Extract tokens if available in result
                if hasattr(result, 'prompt_tokens'):
                    span.prompt_tokens = result.prompt_tokens
                if hasattr(result, 'completion_tokens'):
                    span.completion_tokens = result.completion_tokens
                
                return result
            
            except Exception as e:
                span.status = "failure"
                span.error_code = getattr(e, 'code', 'exception')
                span.error_message = str(e)
                raise
            
            finally:
                span.end_time_ms = time.time_ns() / 1e6
                if trace:
                    trace.add_provider_call(span)
        
        return wrapper
    
    return decorator


def traced_service_call(to_service: str, operation: str = "unknown"):
    """
    Decorator to trace service-to-service calls.
    
    Example:
        @traced_service_call("safety_service", "classify")
        async def classify_response(response):
            ...
    """
    def decorator(func):
        import functools
        
        @functools.wraps(func)
        async def wrapper(*args, **kwargs):
            from_service = func.__module__.split('.')[-2] if '.' in func.__module__ else "unknown"
            trace = RequestTracer.get_current_trace()
            
            span = ServiceCallSpan(
                from_service=from_service,
                to_service=to_service,
                operation=operation,
            )
            
            try:
                result = await func(*args, **kwargs)
                span.status = "success"
                return result
            
            except Exception as e:
                span.status = "failure"
                span.error_code = getattr(e, 'code', 'exception')
                raise
            
            finally:
                span.end_time_ms = time.time_ns() / 1e6
                if trace:
                    trace.add_service_call(span)
        
        return wrapper
    
    return decorator
