# backend/services/llm_service.py

"""
LLM Service re-export module for backward compatibility.
Implementation moved to backend.services.domain.llm.
"""

from __future__ import annotations

from backend.services.domain.llm import (
    LLMProvider,
    LLMService,
    LLMServiceResult,
    OfflineLLMProvider,
    build_llm_request,
    clamp_fallback_count,
    clean_provider_name,
    normalize_provider_response,
)

__all__ = [
    "LLMProvider",
    "LLMService",
    "LLMServiceResult",
    "OfflineLLMProvider",
    "build_llm_request",
    "clamp_fallback_count",
    "clean_provider_name",
    "normalize_provider_response",
]
