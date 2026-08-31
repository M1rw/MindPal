# backend/services/domain/llm/__init__.py

"""
LLM Domain package.
Contains domain models, chat/tool orchestrators, prompt builders, message classification, and LLM services.
"""

from __future__ import annotations

from .chat_orchestrator import ChatOrchestrator
from .freshness import requires_verified_web_search
from .message_classifier import MessageClassification, classify_message
from .protocols import LLMProvider
from .prompts import (
    CLINICAL_PRO_PROMPT,
    PRODUCT_BOUNDARY_PROMPT,
    SAFETY_STYLE_PROMPT,
    VALID_RAG_TAGS,
    WELLNESS_ASSISTANT_PROMPT,
    build_intent_context,
    build_system_prompt,
    build_tiered_prompt,
    get_self_knowledge_response,
    infer_response_mode,
    infer_response_mode_for_preference,
)
from .request_builder import build_llm_request
from .response_parser import normalize_provider_response
from .service import LLMService, LLMServiceResult, OfflineLLMProvider
from .tool_orchestrator import ToolOrchestrator

__all__ = [
    "CLINICAL_PRO_PROMPT",
    "PRODUCT_BOUNDARY_PROMPT",
    "SAFETY_STYLE_PROMPT",
    "VALID_RAG_TAGS",
    "WELLNESS_ASSISTANT_PROMPT",
    "ChatOrchestrator",
    "LLMProvider",
    "LLMService",
    "LLMServiceResult",
    "MessageClassification",
    "OfflineLLMProvider",
    "ToolOrchestrator",
    "build_intent_context",
    "build_llm_request",
    "build_system_prompt",
    "build_tiered_prompt",
    "classify_message",
    "get_self_knowledge_response",
    "infer_response_mode",
    "infer_response_mode_for_preference",
    "normalize_provider_response",
    "requires_verified_web_search",
]
