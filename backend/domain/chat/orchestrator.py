# backend/domain/chat/orchestrator.py — Canonical Chat Orchestrator Pipeline

from __future__ import annotations

from dataclasses import dataclass
from typing import AsyncGenerator, Dict, Any, List, Optional

from backend.domain.safety.classify import SafetyService, SafetyCheckResult
from backend.domain.safety.output_guard import OutputGuardService
from backend.domain.grounding.grounding import GroundingService
from backend.domain.memory.graph import MemoryGraphService
from backend.infra.llm.gateway import LLMGateway, get_llm_gateway


@dataclass(frozen=True, slots=True)
class ChatTurnResult:
    response_text: str
    is_crisis: bool
    risk_level: str
    grounding_used: List[str]
    session_id: Optional[str] = None


class ChatOrchestrator:
    """
    Unified Chat Execution Pipeline.
    Used by both HTTP JSON POST /api/chat and SSE streaming /api/chat/stream.
    """

    def __init__(
        self,
        *,
        safety_service: Optional[SafetyService] = None,
        grounding_service: Optional[GroundingService] = None,
        memory_service: Optional[MemoryGraphService] = None,
        llm_gateway: Optional[LLMGateway] = None,
        output_guard: Optional[OutputGuardService] = None,
    ) -> None:
        self.safety_service = safety_service or SafetyService()
        self.grounding_service = grounding_service or GroundingService()
        self.memory_service = memory_service or MemoryGraphService()
        self.llm_gateway = llm_gateway or get_llm_gateway()
        self.output_guard = output_guard or OutputGuardService()

    async def execute_turn(
        self,
        *,
        user_id_hash: str,
        message: str,
        session_id: Optional[str] = None,
    ) -> ChatTurnResult:
        """Executes a non-streamed chat turn."""
        # 1. Safety Check
        safety: SafetyCheckResult = self.safety_service.classify_message(message)
        if safety.is_crisis and safety.crisis_response:
            return ChatTurnResult(
                response_text=safety.crisis_response,
                is_crisis=True,
                risk_level=safety.risk_level,
                grounding_used=[],
                session_id=session_id,
            )

        # 2. Context & Grounding
        memory_graph = self.memory_service.get_memory_graph(user_id_hash)
        grounding_chunks = self.grounding_service.retrieve_context(message)

        # 3. Prompt Assembly
        system_instruction = (
            "You are MindPal, an empathetic and supportive AI assistant for emotional well-being and reflection.\n"
            f"User context: {memory_graph.summary}\n"
        )
        if grounding_chunks:
            system_instruction += "\nRelevant grounding guidance:\n" + "\n".join(
                f"- {c.topic}: {c.content}" for c in grounding_chunks
            )

        # 4. Single LLM Generation
        response_text = await self.llm_gateway.generate(
            prompt=message,
            system_instruction=system_instruction,
        )

        return ChatTurnResult(
            response_text=response_text,
            is_crisis=False,
            risk_level="none",
            grounding_used=[c.id for c in grounding_chunks],
            session_id=session_id,
        )

    async def execute_turn_stream(
        self,
        *,
        user_id_hash: str,
        message: str,
        session_id: Optional[str] = None,
    ) -> AsyncGenerator[str, None]:
        """Executes a streaming chat turn yielding tokens directly."""
        # 1. Safety Check
        safety: SafetyCheckResult = self.safety_service.classify_message(message)
        if safety.is_crisis and safety.crisis_response:
            yield safety.crisis_response
            return

        # 2. Context & Grounding
        memory_graph = self.memory_service.get_memory_graph(user_id_hash)
        grounding_chunks = self.grounding_service.retrieve_context(message)

        system_instruction = (
            "You are MindPal, an empathetic and supportive AI assistant for emotional well-being and reflection.\n"
            f"User context: {memory_graph.summary}\n"
        )
        if grounding_chunks:
            system_instruction += "\nRelevant grounding guidance:\n" + "\n".join(
                f"- {c.topic}: {c.content}" for c in grounding_chunks
            )

        # 3. Provider Generator -> Output Guard -> Token Yields
        raw_stream = self.llm_gateway.generate_stream(
            prompt=message,
            system_instruction=system_instruction,
        )
        async for token in self.output_guard.guard_stream(raw_stream):
            yield token
