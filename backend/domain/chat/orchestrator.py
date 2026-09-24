# backend/domain/chat/orchestrator.py — Canonical Chat Orchestrator Pipeline

from __future__ import annotations

import asyncio
import functools
import hashlib
import logging
import time
from contextlib import aclosing
from dataclasses import dataclass
from typing import Any, AsyncGenerator, Dict, List, Optional, Sequence

from backend.configs.prompts import CHAT_SYSTEM_BASE
from backend.configs.runtime import behavior_config
from backend.core.errors import AppError
from backend.domain.adaptation.profile import (
    AdaptiveProfileService,
    TurnAdaptation,
    merge_learned_personalization,
    personalization_overrides,
)
from backend.domain.chat.history import normalize_history
from backend.domain.chat.routing import GenerationPlan, plan_generation
from backend.domain.chat.strategy import DIRECTIVES, score_strategies
from backend.domain.chat.trajectory import analyze as analyze_trajectory
from backend.domain.dynamic.policy import current_load, policy
from backend.domain.grounding.grounding import GroundingService
from backend.domain.identity.fence import deleted_since
from backend.domain.memory.extract import can_persist_user_memory, extract_atoms_from_turn
from backend.domain.memory.consolidation import MemoryConsolidationService
from backend.domain.memory.graph import MemoryGraphService, format_memory_receipt
from backend.domain.quota.quota import QuotaDecision, QuotaService, cost_for_model, is_user_quota_subject
from backend.domain.safety.modes.chat.classify import SafetyCheckResult, SafetyService
from backend.domain.safety.shared.output_guard import OutputGuardService, StockSentenceFilter
from backend.infra.llm.gateway import LLMGateway, LLMGatewayError, get_llm_gateway
from backend.infra.store.store import InMemoryStore, StoreUnavailable, get_store
from backend.tools import ClientContextTools
from backend.tools.context import build_tool_context

logger = logging.getLogger("mindpal.chat")

_CHAT_BEHAVIOR = behavior_config()["chat"]
_QUOTA_MESSAGE = _CHAT_BEHAVIOR["quota_message"]
_EMPTY_REPLY_MESSAGE = _CHAT_BEHAVIOR["empty_reply_message"]
_PROVIDER_MESSAGE = _CHAT_BEHAVIOR["provider_message"]
# How far back a crisis disclosure planted in client-sent history still counts.
# Deep enough that shuffling one turn does not evade the check; shallow enough
# that a call which already de-escalated is not re-frozen by old text.
_SAFETY_HISTORY_TURNS = int(_CHAT_BEHAVIOR["safety_history_turns"])
_GROUNDING_HEADER = _CHAT_BEHAVIOR["grounding_header"]


@dataclass(frozen=True, slots=True)
class ChatTurnResult:
    response_text: str
    is_crisis: bool
    risk_level: str
    grounding_used: List[str]
    session_id: Optional[str] = None
    request_id: Optional[str] = None
    strategy_used: Optional[str] = None


@dataclass(frozen=True, slots=True)
class TurnContext:
    strategy: str
    system_instruction: str
    grounding_ids: List[str]
    memory_atoms: int
    has_memory_summary: bool
    plan: GenerationPlan
    trajectory: str


@dataclass(frozen=True, slots=True)
class ChatPreflight:
    safety: SafetyCheckResult
    reservation: Optional[QuotaDecision]
    cost: int
    error: Optional[AppError] = None
    quota_mode: str = "account"
    quota_peer: str = ""
    idempotency_key: str = ""


def _recent_user_turns(history: Optional[Sequence[Any]], *, limit: int) -> List[str]:
    """The last `limit` user-authored turns from a client-supplied history."""
    if not history:
        return []
    turns: List[str] = []
    for item in reversed(list(history)):
        role = (
            str(item.get("role") or "") if isinstance(item, dict) else str(getattr(item, "role", "") or "")
        ).strip().lower()
        if role not in {"user", "human"}:
            continue
        if isinstance(item, dict):
            content = str(item.get("content") or item.get("text") or "")
        else:
            content = str(getattr(item, "content", "") or getattr(item, "text", "") or "")
        content = content.strip()
        if content:
            turns.append(content)
        if len(turns) >= limit:
            break
    return turns


def personalization_note(personalization: Optional[Dict[str, Any]]) -> str:
    """Map client personalization keys onto prompt directives. Safety still overrides this."""
    if not personalization:
        return ""

    style = str(personalization.get("baseStyle") or personalization.get("base_style") or "balanced").lower()
    warmth = str(personalization.get("warmth") or "warm").lower()
    headers = personalization.get("useHeadersLists")
    if headers is None:
        headers = personalization.get("use_headers_lists", True)
    emoji = personalization.get("emojiSupport")
    if emoji is None:
        emoji = personalization.get("emoji_support", True)

    directives: list[str] = []
    if style == "concise":
        directives.append("Keep replies concise, focused, and free of filler.")
    elif style == "detailed":
        directives.append("Provide structured depth, rich perspective, and thoughtful explanations.")
    elif style == "balanced":
        directives.append("Provide a balanced, natural response length.")

    if warmth == "neutral":
        directives.append("Use a grounded, even tone without extra cheer or sentimentality.")
    elif warmth in {"direct", "candid"}:
        directives.append("Be straightforward and plain-spoken; avoid hedging, sugarcoating, and filler.")
    elif warmth == "warm":
        directives.append("Use compassionate warmth and an empathetic, gentle presence.")

    if headers is False:
        directives.append("Write in flowing narrative prose rather than lists or bullet points.")
    elif headers is True and style == "detailed":
        directives.append("Use clear headers and bullet points where they organize complex thoughts.")

    if emoji is False:
        directives.append("Do not use emojis.")
    elif emoji is True:
        directives.append("Use emojis naturally and tastefully where they enhance emotional resonance.")

    if not directives:
        return ""
    return " [Personalization: " + " ".join(directives) + "]"


def provider_model_for_tier(tier: str, default_model: str = "gemini-2.5-flash") -> str:
    """Standard and Pro share one Gemini chat model. Tier changes quota and prompt only."""
    _ = (tier or "").strip().lower()
    return default_model or "gemini-2.5-flash"


def client_context_note(client_context: Optional[Dict[str, Any]]) -> str:
    if not client_context:
        return ""
    timezone_name = client_context.get("timezone")
    if not isinstance(timezone_name, str) or not timezone_name:
        return ""
    context = build_tool_context(client_context)
    if context is None:
        return ""
    return ClientContextTools.system_note(context)


def detect_cognitive_strategy(
    message: str,
    model: str = "standard",
    telemetry: Optional[Dict[str, Any]] = None,
    personalization: Optional[Dict[str, Any]] = None,
    learned_bias: Optional[Dict[str, float]] = None,
) -> tuple[str, str]:
    """
    Tier-1 Dynamic Situation Classifier.
    Understands user situation, emotional state, engagement telemetry, and
    user personalization settings to select optimal cognitive strategy and directive.
    """
    inactivity_count = (telemetry or {}).get("inactivity_count", 0)
    last_idle_secs = (telemetry or {}).get("last_idle_duration_seconds", 0)
    pacing_note = ""
    if inactivity_count >= 2 or last_idle_secs > 45:
        pacing_note = (
            f" [Note: User had {inactivity_count} hesitation/idle periods ({int(last_idle_secs)}s recently). "
            "They may be experiencing cognitive friction or emotional vulnerability. Use gentle pacing and extra warmth.]"
        )

    extras = f"{pacing_note}{personalization_note(personalization)}"

    if model.lower() == "pro":
        strategy = "Thorough"
        directive = (
            "Strategy: Thorough. Take more care with structure and nuance. "
            "Prefer a complete, well-organized reply over a brief one. "
            f"Do not diagnose or treat.{extras}"
        )
        return strategy, directive

    decision = score_strategies(message, learned_bias=learned_bias)
    return decision.strategy, f"{DIRECTIVES[decision.directive_key]}{extras}"


def _record_reply_quality(stock_dropped: int) -> None:
    try:
        from backend.infra.observability.pulse import platform_pulse

        platform_pulse().record_quality("replies")
        platform_pulse().record_quality("stock_sentences_dropped", stock_dropped)
    except Exception:
        logger.debug("reply_quality_record_skipped", exc_info=True)


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
        quota_service: Optional[QuotaService] = None,
    ) -> None:
        self.store = store or get_store()
        self.safety_service = safety_service or SafetyService()
        self.grounding_service = grounding_service or GroundingService()
        self.memory_service = memory_service or MemoryGraphService(self.store)
        self.llm_gateway = llm_gateway or get_llm_gateway()
        self.output_guard = output_guard or OutputGuardService()
        self.quota_service = quota_service or QuotaService(self.store)
        self.adaptation = AdaptiveProfileService(self.store)
        self.consolidation = MemoryConsolidationService(self.store, memory=self.memory_service)

    def record_session_telemetry(self, user_id_hash: str, session_id: Optional[str], telemetry: Optional[Dict[str, Any]]) -> None:
        """Persist engagement telemetry to observe session health and friction.

        Best-effort and non-blocking by design: telemetry is an observability
        nicety, and a storage outage must not be the reason someone's reply
        never arrives. Guests are skipped — with no account key there is no
        row to attribute this to.
        """
        if not session_id or not telemetry or not is_user_quota_subject(user_id_hash):
            return
        doc_key = f"{user_id_hash}:{session_id}"
        try:
            existing = self.store.get_document("session_telemetry", doc_key) or {
                "session_id": session_id,
                "user_id_hash": user_id_hash,
                "turns": 0,
            }
            existing["turns"] = int(existing.get("turns") or 0) + 1
            existing["last_telemetry"] = telemetry
            existing["inactivity_count"] = telemetry.get("inactivity_count", 0)
            existing["active_duration_seconds"] = telemetry.get("active_duration_seconds", 0)
            existing["total_idle_seconds"] = telemetry.get("total_idle_seconds", 0)
            self.store.set_document("session_telemetry", doc_key, existing)
        except StoreUnavailable:
            logger.warning("chat_telemetry_write_skipped_store_unavailable session_id=%s", session_id)

    def _classify_turn(self, message: str, history: Optional[Sequence[Any]] = None) -> SafetyCheckResult:
        """Screen the current message plus the user turns the client just sent.

        `history` is client-supplied and goes straight into the provider prompt.
        Screening only `message` meant a disclosure could be moved one turn back
        — "history": [{"role": "user", "content": "<disclosure>"}] with a bland
        `message` — and the conversation would continue past it with no crisis
        resources offered. Only the most recent turns are screened: older ones
        were already screened when they were the live message, and re-triggering
        on them would freeze a conversation that had already moved on.
        """
        result = self.safety_service.classify_message(message)
        if result.is_crisis:
            return result
        for turn in _recent_user_turns(history, limit=_SAFETY_HISTORY_TURNS):
            recent = self.safety_service.classify_message(turn)
            if recent.is_crisis:
                return recent
        return result

    def _quota_mode(self, *, user_id_hash: str, anonymous: bool) -> str:
        if anonymous or not is_user_quota_subject(user_id_hash):
            return "network"
        return "account"

    def _refund_reservation(self, preflight: Optional[ChatPreflight], *, user_id_hash: str, peer: str, cost: int) -> None:
        mode = preflight.quota_mode if preflight else self._quota_mode(user_id_hash=user_id_hash, anonymous=bool(peer))
        refund_peer = preflight.quota_peer if preflight else peer
        idempotency_key = preflight.idempotency_key if preflight else ""
        # The reservation knows which credit windows it charged; the refund goes back there.
        reservation = preflight.reservation if preflight else None
        if mode == "network":
            self.quota_service.refund_anonymous(refund_peer, cost, idempotency_key=idempotency_key, reservation=reservation)
            return
        self.quota_service.refund_quota(user_id_hash, cost, idempotency_key=idempotency_key, reservation=reservation)

    def preflight_turn(
        self,
        *,
        user_id_hash: str,
        message: str,
        history: Optional[Sequence[Any]] = None,
        model: str = "standard",
        anonymous: bool = False,
        peer: str = "",
        idempotency_key: str = "",
    ) -> ChatPreflight:
        """Safety first. Quota is reserved only when the turn will call the provider."""
        quota_mode = self._quota_mode(user_id_hash=user_id_hash, anonymous=anonymous)
        quota_peer = peer if quota_mode == "network" else ""
        safety = self._classify_turn(message, history)
        if safety.is_crisis and safety.crisis_response:
            return ChatPreflight(
                safety=safety,
                reservation=None,
                cost=0,
                quota_mode=quota_mode,
                quota_peer=quota_peer,
                idempotency_key=idempotency_key,
            )
        cost = cost_for_model(model)
        request_digest = hashlib.sha256(f"{model}:{message}".encode("utf-8")).hexdigest() if idempotency_key else ""
        if quota_mode == "network":
            decision = self.quota_service.reserve_anonymous(
                quota_peer, cost, idempotency_key=idempotency_key, request_digest=request_digest
            )
        else:
            decision = self.quota_service.reserve(
                user_id_hash, cost, idempotency_key=idempotency_key, request_digest=request_digest
            )
        if not decision.allowed:
            return ChatPreflight(
                safety=safety,
                reservation=None,
                cost=cost,
                error=AppError("quota_exceeded", _QUOTA_MESSAGE, details=decision.as_usage()),
                quota_mode=quota_mode,
                quota_peer=quota_peer,
                idempotency_key=idempotency_key,
            )
        return ChatPreflight(
            safety=safety,
            reservation=decision,
            cost=cost,
            quota_mode=quota_mode,
            quota_peer=quota_peer,
            idempotency_key=idempotency_key,
        )

    def _assemble_system_instruction(
        self,
        *,
        user_id_hash: str,
        message: str,
        model: str,
        telemetry: Optional[Dict[str, Any]],
        personalization: Optional[Dict[str, Any]],
        client_context: Optional[Dict[str, Any]],
        adaptation: Optional[TurnAdaptation] = None,
        history: Optional[Sequence[Any]] = None,
    ) -> "TurnContext":
        learned_profile = adaptation.profile if adaptation else {}
        trajectory = analyze_trajectory(history, message)
        bias: Dict[str, float] = dict(adaptation.bias) if adaptation else {}
        for name, value in trajectory.strategy_bias().items():
            bias[name] = bias.get(name, 0.0) + value
        effective_personalization = merge_learned_personalization(personalization, personalization_overrides(learned_profile))
        strategy, strategy_directive = detect_cognitive_strategy(
            message,
            model=model,
            telemetry=telemetry,
            personalization=effective_personalization,
            learned_bias=bias or None,
        )
        plan = plan_generation(
            message=message,
            strategy=strategy,
            reflecting_distress=strategy_directive.startswith(DIRECTIVES["reflect"][:40]),
            trajectory=trajectory,
            personalization=effective_personalization,
            load=current_load(),
        )
        memory = self.memory_service.prompt_for_user(user_id_hash)
        grounding_chunks = self.grounding_service.retrieve_context(
            message, semantic=bool(current_load().policy("retrieval")["semantic"])
        )
        system_instruction = CHAT_SYSTEM_BASE + f"{strategy_directive}\n"
        if adaptation and adaptation.note:
            system_instruction += f"{adaptation.note}\n"
        trajectory_note = trajectory.note()
        if trajectory_note:
            system_instruction += f"{trajectory_note}\n"
        context_note = client_context_note(client_context)
        if context_note:
            system_instruction += f"{context_note}\n"
        if memory.text:
            system_instruction += f"{memory.text}\n"
        if grounding_chunks:
            system_instruction += "\n" + _GROUNDING_HEADER + "\n" + "\n".join(
                f"- {c.topic}: {c.content}" for c in grounding_chunks
            )
        return TurnContext(
            strategy=strategy,
            system_instruction=system_instruction,
            grounding_ids=[c.id for c in grounding_chunks],
            memory_atoms=memory.atom_count,
            has_memory_summary=memory.has_summary,
            plan=plan,
            trajectory=trajectory.direction,
        )

    def _sse_error(self, code: str, message: str, *, request_id: Optional[str], strategy: str) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "error": {"code": code, "message": message},
            "strategy_used": strategy,
        }
        if request_id:
            payload["request_id"] = request_id
        return payload

    async def execute_turn(
        self,
        *,
        user_id_hash: str,
        message: str,
        session_id: Optional[str] = None,
        model: str = "standard",
        telemetry: Optional[Dict[str, Any]] = None,
        personalization: Optional[Dict[str, Any]] = None,
        client_context: Optional[Dict[str, Any]] = None,
        history: Optional[Sequence[Any]] = None,
        request_id: Optional[str] = None,
    ) -> ChatTurnResult:
        """Executes a non-streamed chat turn."""
        parts: list[str] = []
        strategy = "Active Listen"
        is_crisis = False
        risk_level = "none"
        grounding_used: List[str] = []
        async for chunk in self.execute_turn_stream(
            user_id_hash=user_id_hash,
            message=message,
            session_id=session_id,
            model=model,
            telemetry=telemetry,
            personalization=personalization,
            client_context=client_context,
            history=history,
            request_id=request_id,
            consume_quota=False,
        ):
            if chunk.get("error"):
                raise AppError(str(chunk["error"].get("code") or "unavailable"), str(chunk["error"].get("message") or _PROVIDER_MESSAGE))
            if chunk.get("text"):
                parts.append(str(chunk["text"]))
            if chunk.get("strategy_used"):
                strategy = str(chunk["strategy_used"])
            if chunk.get("is_crisis"):
                is_crisis = True
                risk_level = str(chunk.get("risk_level") or "imminent")
            if chunk.get("grounding_used"):
                grounding_used = list(chunk["grounding_used"])
        return ChatTurnResult(
            response_text="".join(parts),
            is_crisis=is_crisis,
            risk_level=risk_level,
            grounding_used=grounding_used,
            session_id=session_id,
            request_id=request_id,
            strategy_used=strategy,
        )

    async def execute_turn_stream(
        self,
        *,
        user_id_hash: str,
        message: str,
        session_id: Optional[str] = None,
        model: str = "standard",
        telemetry: Optional[Dict[str, Any]] = None,
        personalization: Optional[Dict[str, Any]] = None,
        client_context: Optional[Dict[str, Any]] = None,
        history: Optional[Sequence[Any]] = None,
        request_id: Optional[str] = None,
        preflight: Optional[ChatPreflight] = None,
        consume_quota: bool = True,
        anonymous: bool = False,
        peer: str = "",
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """Executes a streaming chat turn yielding tokens, strategy, and structured errors."""
        turn_started = time.time()
        # Store and model-free work below is blocking I/O; it runs in a worker
        # thread so a slow store stalls this turn, not every stream on the
        # event loop (audit MP-09).
        await asyncio.to_thread(self.record_session_telemetry, user_id_hash, session_id, telemetry)
        completed = False
        reservation = preflight.reservation if preflight else None
        cost = preflight.cost if preflight else cost_for_model(model)
        active_preflight = preflight

        try:
            safety = preflight.safety if preflight else await asyncio.to_thread(self._classify_turn, message, history)
            logger.info(
                "chat_turn_start request_id=%s model=%s safety=%s crisis=%s",
                request_id or "-",
                model,
                safety.risk_level,
                safety.is_crisis,
            )

            if safety.is_crisis and safety.crisis_response:
                logger.info(
                    "chat_turn_safety_override request_id=%s decision=crisis strategy=Safety Shield",
                    request_id or "-",
                )
                yield {
                    "text": safety.crisis_response,
                    "strategy_used": "Safety Shield",
                    "is_crisis": True,
                    "risk_level": safety.risk_level,
                    "request_id": request_id,
                }
                completed = True
                return

            if consume_quota and reservation is None:
                local = await asyncio.to_thread(
                    self.preflight_turn,
                    user_id_hash=user_id_hash,
                    message=message,
                    history=history,
                    model=model,
                    anonymous=anonymous,
                    peer=peer,
                )
                if local.error:
                    yield self._sse_error(local.error.code, local.error.message, request_id=request_id, strategy="Quota")
                    completed = True
                    return
                reservation = local.reservation
                cost = local.cost
                safety = local.safety
                active_preflight = local

            if reservation:
                yield {"usage": reservation.as_usage(), "request_id": request_id}

            turns = normalize_history(history, message)
            # Under heavy load, send a shorter window of history (fewer tokens per
            # turn); memory and the AI summary still carry the longer context.
            history_scale = float(policy("chat")["history_scale"])
            if history_scale < 1.0 and len(turns) > 8:
                turns = turns[-max(8, int(len(turns) * history_scale)) :]
            learn = is_user_quota_subject(user_id_hash) and not anonymous
            adaptation = await asyncio.to_thread(self._prepare_adaptation, user_id_hash, message, persist=learn)
            context = await asyncio.to_thread(
                self._assemble_system_instruction,
                user_id_hash=user_id_hash,
                message=message,
                model=model,
                telemetry=telemetry,
                personalization=personalization,
                client_context=client_context,
                adaptation=adaptation,
                history=history,
            )
            strategy, system_instruction, grounding_ids = context.strategy, context.system_instruction, context.grounding_ids
            memory_atoms, has_memory_summary = context.memory_atoms, context.has_memory_summary
            logger.info(
                "chat_turn_generate request_id=%s strategy=%s history_turns=%s grounding=%s memory_atoms=%s memory_summary=%s",
                request_id or "-",
                strategy,
                len(turns),
                len(grounding_ids),
                memory_atoms,
                "yes" if has_memory_summary else "no",
            )

            raw_stream = self.llm_gateway.generate_stream(
                prompt=message,
                system_instruction=system_instruction,
                history=turns,
                model=provider_model_for_tier(
                    model,
                    getattr(self.llm_gateway, "default_model", "gemini-2.5-flash") or "gemini-2.5-flash",
                ),
                max_tokens=context.plan.max_tokens,
                thinking_budget=context.plan.thinking_budget,
            )
            logger.info(
                "chat_turn_plan request_id=%s depth=%s reason=%s thinking=%s max_tokens=%s trajectory=%s",
                request_id or "-",
                context.plan.depth,
                context.plan.reason,
                context.plan.thinking_budget,
                context.plan.max_tokens,
                context.trajectory,
            )
            token_count = 0
            reply_parts: List[str] = []
            reply_chars = 0
            try:
                stock_filter = StockSentenceFilter()
                async with aclosing(stock_filter.filter(self.output_guard.guard_stream(raw_stream))) as guarded:
                    async for token in guarded:
                        if not token:
                            continue
                        token_count += 1
                        if reply_chars < 1200:
                            reply_parts.append(token)
                            reply_chars += len(token)
                        yield {
                            "text": token,
                            "strategy_used": strategy,
                            "request_id": request_id,
                            "grounding_used": grounding_ids,
                        }
            except LLMGatewayError as exc:
                logger.warning(
                    "chat_turn_provider_error request_id=%s code=%s",
                    request_id or "-",
                    exc.code,
                )
                yield self._sse_error(exc.code, exc.message, request_id=request_id, strategy=strategy)
                return

            if token_count == 0:
                logger.warning("chat_turn_empty_output request_id=%s strategy=%s", request_id or "-", strategy)
                yield self._sse_error("unavailable", _EMPTY_REPLY_MESSAGE, request_id=request_id, strategy=strategy)
                return

            completed = True
            _record_reply_quality(stock_filter.dropped)
            receipt = await asyncio.to_thread(
                functools.partial(
                    self._persist_turn,
                    user_id_hash=user_id_hash,
                    message=message,
                    reply="".join(reply_parts),
                    strategy=strategy,
                    learn=learn,
                    anonymous=anonymous,
                    turn_started=turn_started,
                    request_id=request_id,
                )
            )
            logger.info(
                "chat_turn_complete request_id=%s strategy=%s tokens=%s memory_atoms_written=%s",
                request_id or "-",
                strategy,
                token_count,
                receipt["count"] if receipt else 0,
            )
            if receipt and receipt.get("saved"):
                payload: Dict[str, Any] = {"memory": receipt}
                if request_id:
                    payload["request_id"] = request_id
                yield payload
        finally:
            if reservation and not completed:
                logger.info("chat_turn_refund request_id=%s", request_id or "-")
                self._refund_reservation(active_preflight, user_id_hash=user_id_hash, peer=peer, cost=cost)

    def _persist_turn(
        self,
        *,
        user_id_hash: str,
        message: str,
        reply: str,
        strategy: str,
        learn: bool,
        anonymous: bool,
        turn_started: float,
        request_id: Optional[str],
    ) -> Optional[Dict[str, Any]]:
        """Everything a finished turn writes. Blocking I/O: called in a worker thread."""
        # The reply took seconds; if the account's data was deleted meanwhile,
        # nothing learned from this turn may be written back (audit MP-06).
        fenced = not anonymous and deleted_since(self.store, user_id_hash, turn_started)
        if fenced:
            logger.info("chat_turn_writes_fenced request_id=%s reason=account_data_deleted", request_id or "-")
            return None
        if learn:
            self.adaptation.commit_turn(user_id_hash, message, strategy)
        receipt = self._write_turn_memory(user_id_hash, message, request_id=request_id)
        if learn:
            # Collected for later AI consolidation; no model call happens here.
            self.consolidation.record_turn(
                user_id_hash,
                message,
                reply,
                new_facts=int(receipt["count"]) if receipt else 0,
            )
        return receipt

    def _prepare_adaptation(self, user_id_hash: str, message: str, *, persist: bool) -> Optional[TurnAdaptation]:
        """What this person's history says works for them. Never blocks a reply."""
        try:
            return self.adaptation.prepare_turn(user_id_hash, message, persist=persist)
        except Exception as exc:
            logger.warning("adaptive_profile_prepare_skipped error=%s", type(exc).__name__)
            return None

    def _write_turn_memory(
        self,
        user_id_hash: str,
        message: str,
        *,
        request_id: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """Extract durable facts from this user message. Persist only for signed-in users.

        Guests still receive a receipt so the client can store atoms on-device.
        Never logs reflective text. Never writes the shared `usr_anon_default` graph.
        """
        persist = can_persist_user_memory(user_id_hash)
        try:
            atoms = extract_atoms_from_turn(message)
            if not atoms:
                logger.info("chat_turn_memory_write request_id=%s atoms=0", request_id or "-")
                return None
            if not persist:
                receipt = format_memory_receipt(atoms)
                logger.info(
                    "chat_turn_memory_write request_id=%s skipped=no_persist atoms=%s",
                    request_id or "-",
                    receipt["count"],
                )
                return receipt if receipt["saved"] else None
            _graph, saved = self.memory_service.merge_atoms(user_id_hash, atoms)
            receipt = format_memory_receipt(saved)
            logger.info(
                "chat_turn_memory_write request_id=%s atoms=%s",
                request_id or "-",
                receipt["count"],
            )
            if not receipt["saved"]:
                return None
            return receipt
        except Exception as exc:
            logger.warning(
                "chat_turn_memory_write_failed request_id=%s error=%s",
                request_id or "-",
                type(exc).__name__,
            )
            return None
