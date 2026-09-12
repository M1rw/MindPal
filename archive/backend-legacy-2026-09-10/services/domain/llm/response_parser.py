# backend/services/domain/llm/response_parser.py

from __future__ import annotations

from backend.core.security import sanitize_text
from backend.models.chat import LLMResponse

MAX_PROVIDER_NAME_CHARS: int = 120
MAX_FALLBACK_COUNT: int = 10


def normalize_provider_response(
    response: LLMResponse,
    *,
    provider_name: str,
    fallback_count: int,
    latency_ms: float,
) -> LLMResponse:
    """
    Normalize raw provider response with consistent metadata and latency bounds.

    Args:
        response: Raw LLMResponse produced by provider.
        provider_name: Fallback provider identifier.
        fallback_count: Number of previous failed provider attempts.
        latency_ms: Measured execution latency in milliseconds.

    Returns:
        Standardized LLMResponse domain instance.
    """
    clean_provider = clean_provider_name(response.provider_used or provider_name)
    bounded_latency = max(0.0, float(latency_ms))

    return LLMResponse(
        text=response.text,
        provider_used=clean_provider,
        fallback_count=clamp_fallback_count(fallback_count),
        latency_ms=bounded_latency,
        model_name=response.model_name,
        finish_reason=response.finish_reason,
    )


def clamp_fallback_count(value: int) -> int:
    """Clamp provider fallback counter between 0 and 10."""
    try:
        return max(0, min(int(value), MAX_FALLBACK_COUNT))
    except (ValueError, TypeError):
        return 0


def clean_provider_name(value: str) -> str:
    """Sanitize provider identifier string to prevent injection or formatting breakages."""
    cleaned = sanitize_text(str(value or "").strip(), MAX_PROVIDER_NAME_CHARS)
    return cleaned or "unknown"
