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

import re
from backend.infra.store.store import InMemoryStore, get_store


def detect_cognitive_strategy(message: str, model: str = "standard", telemetry: Optional[Dict[str, Any]] = None) -> tuple[str, str]:
    """
    Tier-1 Dynamic Situation Classifier.
    Understands user situation, emotional state, and engagement telemetry to select
    the optimal cognitive support strategy and tailored clinical prompt directive.
    """
    msg_lower = message.lower()

    if model.lower() == "pro":
        strategy = "Clinical Depth"
        directive = (
            "Strategy: Clinical Depth. Engage with multi-layered psychological reasoning. "
            "Explore underlying cognitive schemas, somatic reactions, and dialectical synthesis. "
            "Provide high-clarity structural insights while maintaining warm therapeutic rapport."
        )
        return strategy, directive

    # Telemetry-aware hesitation / emotional friction detection
    inactivity_count = (telemetry or {}).get("inactivity_count", 0)
    last_idle_secs = (telemetry or {}).get("last_idle_duration_seconds", 0)
    pacing_note = ""
    if inactivity_count >= 2 or last_idle_secs > 45:
        pacing_note = (
            f" [Note: User had {inactivity_count} hesitation/idle periods ({int(last_idle_secs)}s recently). "
            "They may be experiencing cognitive friction or emotional vulnerability. Use gentle pacing and extra warmth.]"
        )

    # 1. Acute Distress & Emotional Venting -> Active Empathetic Reflection
    distress_patterns = r"\b(overwhelm|crying|panic|scared|sad|depressed|hopeless|exhausted|hurt|hurts|anxious|anxiety|grief|lonely|alone|broken|can't take|terrified)\b"
    if re.search(distress_patterns, msg_lower):
        strategy = "Active Listen"
        directive = (
            "Strategy: Active Empathetic Reflection. The user is in an emotional or overwhelmed state. "
            "Prioritize deep validation, emotional attunement, non-judgmental containment, and somatic grounding. "
            f"DO NOT jump to unsolicited advice or problem-solving yet.{pacing_note}"
        )
        return strategy, directive

    # 2. Cognitive Distortions & Catastrophic Thinking -> Cognitive Tools
    distortion_patterns = r"\b(always fail|never get|worthless|hate myself|ruined|pointless|everyone hates|terrible person|no way out|stupid of me|hopeless)\b"
    if re.search(distortion_patterns, msg_lower):
        strategy = "Cognitive Tools"
        directive = (
            "Strategy: Cognitive Tools. The user is caught in cognitive distortion or catastrophic thought loops. "
            "Gently guide them with cognitive defusion, evidence-testing questions, and self-compassion reframing. "
            f"Help them observe the thought without identifying fully with it.{pacing_note}"
        )
        return strategy, directive

    # 3. Decision Making & Problem Solving -> Guided Solution Coaching
    coaching_patterns = r"\b(what should i|how (do|can) i|help me (decide|plan|figure|choose)|advice|solution|next step|solve|options|stuck on)\b"
    if re.search(coaching_patterns, msg_lower):
        strategy = "Guided Coach"
        directive = (
            "Strategy: Guided Solution Coaching. The user is seeking clarity or action. "
            "Help them deconstruct the challenge into manageable, atomic micro-steps using structured Socratic coaching. "
            f"Foster their own agency rather than prescribing rigid answers.{pacing_note}"
        )
        return strategy, directive

    # 4. Default -> Mindful Presence
    strategy = "Active Listen"
    directive = (
        "Strategy: Mindful Presence. Meet the user where they are with warmth, reflective mirroring, "
        f"and thoughtful, curious inquiry.{pacing_note}"
    )
    return strategy, directive


class ChatOrchestrator:
    """
    Unified Chat Execution Pipeline.
    Used by both HTTP JSON POST /api/chat and SSE streaming /api/chat/stream.
    Integrates dynamic cognitive mode adaptation and session telemetry.
    """

    def __init__(
        self,
        *,
        safety_service: Optional[SafetyService] = None,
        grounding_service: Optional[GroundingService] = None,
        memory_service: Optional[MemoryGraphService] = None,
        llm_gateway: Optional[LLMGateway] = None,
        output_guard: Optional[OutputGuardService] = None,
        store: Optional[InMemoryStore] = None,
    ) -> None:
        self.safety_service = safety_service or SafetyService()
        self.grounding_service = grounding_service or GroundingService()
        self.memory_service = memory_service or MemoryGraphService()
        self.llm_gateway = llm_gateway or get_llm_gateway()
        self.output_guard = output_guard or OutputGuardService()
        self.store = store or get_store()

    def record_session_telemetry(self, user_id_hash: str, session_id: Optional[str], telemetry: Optional[Dict[str, Any]]) -> None:
        """Persists engagement telemetry to observe session health and user friction patterns."""
        if not session_id or not telemetry:
            return
        doc_key = f"{user_id_hash}:{session_id}"
        existing = self.store.get_document("session_telemetry", doc_key) or {
            "session_id": session_id,
            "user_id_hash": user_id_hash,
            "turns": 0,
        }
        existing["turns"] = existing.get("turns", 0) + 1
        existing["last_telemetry"] = telemetry
        existing["inactivity_count"] = telemetry.get("inactivity_count", 0)
        existing["active_duration_seconds"] = telemetry.get("active_duration_seconds", 0)
        existing["total_idle_seconds"] = telemetry.get("total_idle_seconds", 0)
        self.store.set_document("session_telemetry", doc_key, existing)

    async def execute_turn(
        self,
        *,
        user_id_hash: str,
        message: str,
        session_id: Optional[str] = None,
        model: str = "standard",
        telemetry: Optional[Dict[str, Any]] = None,
    ) -> ChatTurnResult:
        """Executes a non-streamed chat turn."""
        self.record_session_telemetry(user_id_hash, session_id, telemetry)

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

        # 2. Dynamic Cognitive Strategy & Telemetry Guidance
        strategy, strategy_directive = detect_cognitive_strategy(message, model=model, telemetry=telemetry)

        # 3. Context & Grounding
        memory_graph = self.memory_service.get_memory_graph(user_id_hash)
        grounding_chunks = self.grounding_service.retrieve_context(message)

        # 4. Prompt Assembly
        system_instruction = (
            "You are MindPal, an empathetic and supportive AI companion for emotional well-being and reflection.\n"
            f"{strategy_directive}\n"
            f"User context: {memory_graph.summary}\n"
        )
        if grounding_chunks:
            system_instruction += "\nRelevant grounding guidance:\n" + "\n".join(
                f"- {c.topic}: {c.content}" for c in grounding_chunks
            )

        # 5. Single LLM Generation
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
        model: str = "standard",
        telemetry: Optional[Dict[str, Any]] = None,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """Executes a streaming chat turn yielding tokens and chosen strategy."""
        self.record_session_telemetry(user_id_hash, session_id, telemetry)

        # 1. Safety Check
        safety: SafetyCheckResult = self.safety_service.classify_message(message)
        if safety.is_crisis and safety.crisis_response:
            yield {"text": safety.crisis_response, "strategy_used": "Safety Shield"}
            return

        # 2. Dynamic Cognitive Strategy & Telemetry Guidance
        strategy, strategy_directive = detect_cognitive_strategy(message, model=model, telemetry=telemetry)

        # 3. Context & Grounding
        memory_graph = self.memory_service.get_memory_graph(user_id_hash)
        grounding_chunks = self.grounding_service.retrieve_context(message)

        system_instruction = (
            "You are MindPal, an empathetic and supportive AI companion for emotional well-being and reflection.\n"
            f"{strategy_directive}\n"
            f"User context: {memory_graph.summary}\n"
        )
        if grounding_chunks:
            system_instruction += "\nRelevant grounding guidance:\n" + "\n".join(
                f"- {c.topic}: {c.content}" for c in grounding_chunks
            )

        # 4. Provider Generator -> Output Guard -> Token Yields with Strategy metadata
        raw_stream = self.llm_gateway.generate_stream(
            prompt=message,
            system_instruction=system_instruction,
        )
        is_first = True
        async for token in self.output_guard.guard_stream(raw_stream):
            if is_first:
                yield {"text": token, "strategy_used": strategy}
                is_first = False
            else:
                yield {"text": token, "strategy_used": strategy}

