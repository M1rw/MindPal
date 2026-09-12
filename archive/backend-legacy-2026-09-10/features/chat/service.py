# backend/features/chat/service.py

"""
Core chat pipeline orchestration: safety, memory, RAG, LLM, quality finalization.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from backend.core.security import sanitize_text
from backend.features.safety.schemas import SafetyDecision
from .schemas import (
    ChatMessage,
    ChatMetadata,
    ChatRequest,
    ChatResponse,
    LLMMessage,
    LLMRole,
    RagReference,
)

logger = logging.getLogger(__name__)

MAX_HISTORY_FOR_LLM = 30
MEMORY_COMPACTION_TIMEOUT_SECONDS = 8.0
SAFETY_EVENT_TIMEOUT_SECONDS = 4.0


class ChatService:
    """
    Coordinates the full chat pipeline:
    1. Safety classification
    2. Memory context loading
    3. RAG retrieval
    4. Tool pre-execution
    5. Prompt assembly and LLM call
    6. Output guard and quality finalization
    7. Async memory compaction
    """

    def __init__(self, *, services: Any = None) -> None:
        self.services = services

    async def handle(
        self,
        *,
        request: ChatRequest,
        user_id_hash: str,
        authenticated: bool,
        locale: str,
        channel: str,
        timezone: str,
        request_id: str,
    ) -> ChatResponse:
        services = self.services

        # Step 1: Safety classification
        safety_decision = services.safety.classify_message(request.messages[-1].content, locale=locale)
        if safety_decision.bypass_llm:
            return self._deterministic_safety_response(safety_decision, request_id=request_id)

        # Step 2: Memory context
        memory_prompt = ""
        if authenticated and services.memory:
            try:
                memory_prompt = await services.memory.get_prompt_context(user_id_hash)
            except Exception:
                logger.warning("memory_load_failed request_id=%s", request_id)

        # Step 3: Build LLM messages
        llm_messages = self._build_llm_messages(request.messages, memory_prompt=memory_prompt)

        # Step 4: LLM call
        try:
            raw_reply = await services.llm.complete(
                messages=llm_messages,
                request_id=request_id,
                metadata={"locale": locale, "channel": channel},
            )
        except Exception as exc:
            logger.error("llm_failure request_id=%s error=%s", request_id, type(exc).__name__)
            raise

        # Step 5: Output guard
        final_reply = sanitize_text(raw_reply, 12_000)

        return ChatResponse(
            message=final_reply,
            request_id=request_id,
            provider=getattr(services, "llm", None) and getattr(services.llm, "provider_name", "gemini") or "gemini",
            safety_level=safety_decision.level.value,
            from_cache=False,
        )

    def _build_llm_messages(self, messages: list[ChatMessage], *, memory_prompt: str = "") -> list[dict[str, str]]:
        result: list[dict[str, str]] = []
        if memory_prompt:
            result.append({"role": "system", "content": memory_prompt})
        for msg in messages[-MAX_HISTORY_FOR_LLM:]:
            result.append({"role": msg.role.value, "content": msg.content})
        return result

    def _deterministic_safety_response(self, decision: SafetyDecision, *, request_id: str) -> ChatResponse:
        msg = (
            "I'm here with you. If you're having thoughts of hurting yourself, please reach out to a crisis line — "
            "they're available 24/7 to support you."
            if decision.level.value == "self_harm_imminent"
            else "I hear you. I'm here to support you through this. Would you like to talk more about what's going on?"
        )
        return ChatResponse(
            message=msg,
            request_id=request_id,
            safety_level=decision.level.value,
            from_cache=False,
        )
