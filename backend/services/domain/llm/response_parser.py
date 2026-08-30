# backend/services/domain/llm/response_parser.py

from __future__ import annotations

from backend.core.security import sanitize_text
from backend.models.chat import LLMResponse

MAX_PROVIDER_NAME_CHARS = 120


def normalize_provider_response(
    response: LLMResponse,
    *,
    provider_name: str,
    fallback_count: int,
    latency_ms: float,
) -> LLMResponse:
    return LLMResponse(
        text=response.text,
        provider_used=response.provider_used or provider_name,
        fallback_count=clamp_fallback_count(fallback_count),
        latency_ms=latency_ms,
        model_name=response.model_name,
        finish_reason=response.finish_reason,
    )


def clamp_fallback_count(value: int) -> int:
    return max(0, min(int(value), 10))


def clean_provider_name(value: str) -> str:
    cleaned = sanitize_text(str(value or ""), MAX_PROVIDER_NAME_CHARS)
    return cleaned or "unknown"
