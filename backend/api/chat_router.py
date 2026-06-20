# backend/api/chat_router.py

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, status

from backend.api.dependencies import (
    AuthenticatedRequestContextDep,
    RequestContextDep,
    ServiceContainer,
    ServicesDep,
    http_error_from_app_error,
)
from backend.core.errors import AppError

logger = logging.getLogger(__name__)
from backend.core.prompts import build_intent_context, build_system_prompt, infer_response_mode_for_preference
from backend.core.security import sanitize_text
from backend.tools import ToolContext, build_default_registry
from backend.models.chat import (
    ChatRequest,
    ChatResponse,
    ChatSafetyView,
    LLMMessage,
    LLMRole,
)
from backend.models.schemas import ProviderChainTrace
from backend.models.memory import (
    MemoryCompactionRequest,
    MemoryGraph,
    MemorySource,
    MemorySummary,
    memory_graph_from_summary,
    summary_from_memory_graph,
)
from backend.models.safety import SafetyDecision
from backend.models.user import UserProfile
from backend.services.llm_service import build_llm_request
from backend.services.memory_graph_service import (
    build_memory_graph_prompt,
    extract_memory_graph_from_text_llm,
    memory_graph_delta_from_summary,
    merge_memory_graph,
)
from backend.services.memory_service import build_memory_interactions


router = APIRouter(prefix="/api", tags=["chat"])

MAX_HISTORY_FOR_LLM = 30
MAX_USER_PREFS_PROMPT_CHARS = 1_200
MEMORY_COMPACTION_TIMEOUT_SECONDS = 8.0
SAFETY_EVENT_TIMEOUT_SECONDS = 4.0

# Lazy singleton tool registry
_tool_registry = None

# Background task tracker — prevents GC of in-flight tasks
_background_tasks: set[asyncio.Task] = set()


def _get_tool_registry():
    global _tool_registry
    if _tool_registry is None:
        _tool_registry = build_default_registry()
    return _tool_registry


@router.get("/chat/debug/{request_id}", response_model=ProviderChainTrace)
async def chat_debug(
    request_id: str,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> ProviderChainTrace:
    """
    Retrieve LLM trace data for a specific request.
    Used for the MindPal debug panel.
    """
    trace = services.llm.get_trace(sanitize_text(request_id, 80))

    if trace and trace.user_id_hash and trace.user_id_hash != context.session.user_id_hash:
        logger.warning(
            "User %s attempted to access trace %s owned by %s",
            context.session.user_id_hash, request_id, trace.user_id_hash
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "access_denied",
                "message": "You do not have permission to view this trace",
                "request_id": context.request_id,
            },
        )

    if not trace:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": "trace_not_found",
                "message": "Trace not found in cache",
                "request_id": context.request_id,
            },
        )
    return trace


@router.post("/chat", response_model=ChatResponse)
async def chat(
    payload: ChatRequest,
    services: ServicesDep,
    context: RequestContextDep,
) -> ChatResponse:
    """
    Main MindPal chat route.

    Production safety order:
    1. classify input before LLM response generation
    2. deterministic crisis bypass if required
    3. load profile/memory only for authenticated users
    4. retrieve RAG grounding
    5. generate LLM answer
    6. output-guard generated answer before returning
    7. persist safety/memory inline best-effort, not queued background work

    Anonymous chat is allowed as guest mode, but it does not get durable
    Firestore profile or memory persistence.
    """
    locale = _resolve_locale(payload, context.locale)
    authenticated = bool(context.session.authenticated)

    try:
        safety_decision = await services.safety.classify_input_with_context(
            payload.message,
            locale=locale,
            memory_summary=None,
            channel=context.channel.value,
        )

        if safety_decision.bypass_llm:
            return await _handle_deterministic_safety_response(
                services=services,
                context=context,
                locale=locale,
                safety_decision=safety_decision,
            )

        deterministic_context_reply = _maybe_answer_chat_context_question(payload)

        if deterministic_context_reply:
            return ChatResponse(
                reply=deterministic_context_reply,
                safety=_safety_view(safety_decision),
                provider_used="deterministic_chat_context",
                fallback_count=0,
                rag_used=[],
                memory_updated=False,
                request_id=context.request_id,
            )

        profile = await _load_chat_profile(
            services=services,
            context=context,
            authenticated=authenticated,
        )

        memory_summary = None
        memory_graph = None
        memory_prompt = ""

        memory_allowed = bool(
            authenticated
            and profile.preferences.safety.allow_memory
        )

        if memory_allowed:
            memory_graph = await _load_or_migrate_memory_graph_inline(
                services=services,
                user_id_hash=context.session.user_id_hash,
            )
            memory_summary = summary_from_memory_graph(memory_graph)
            memory_prompt = build_memory_graph_prompt(memory_graph)

        rag_tags = services.safety.rag_tags_for_decision(safety_decision)
        intent_context = build_intent_context(payload.message, locale=locale)

        # Infer mode from semantic intake + safety + user's listening preference.
        user_preference = payload.metadata.mode or ""
        clinical_mode = payload.metadata.model == "pro"
        response_mode = infer_response_mode_for_preference(
            preference=user_preference,
            safety_level=safety_decision.level.value,
            rag_tags=rag_tags,
            user_message=payload.message,
            intent_context=intent_context,
        )

        rag_result = await services.rag.retrieve_contextual(
            payload.message,
            safety_tags=rag_tags,
            locale=locale,
            memory_summary=memory_prompt,
            max_results=4,
        )

        # ─── Tool context + pre-execution ───
        registry = _get_tool_registry()
        tool_descriptions = registry.get_tool_descriptions_prompt()
        tool_context = ToolContext(
            user_id_hash=context.session.user_id_hash,
            authenticated=authenticated,
            locale=locale,
            timezone=payload.metadata.timezone or "UTC",
            request_id=context.request_id,
            services=services,
            chat_history=[
                {"role": m.role.value if hasattr(m.role, "value") else str(m.role), "content": m.content}
                for m in (payload.history or [])
            ],
        )

        # Pre-execute tools for obvious cases and inject results into context
        tool_results_text = await _pre_execute_tools(payload.message, registry, tool_context)

        system_prompt = build_system_prompt(
            memory_prompt,
            list(rag_result.prompt_grounding),
            locale,
            response_mode=response_mode,
            safety_level=safety_decision.level.value,
            channel=context.channel.value,
            user_preferences=_build_user_preferences_prompt(profile, payload.metadata),
            intent_context=intent_context,
            clinical_mode=clinical_mode,
            tool_descriptions=tool_descriptions,
            user_timezone=payload.metadata.timezone or "UTC",
        )

        # If tools pre-executed, prepend results to user message for context
        effective_message = payload.message
        if tool_results_text:
            effective_message = (
                f"[Tool results for your reference — do not expose this block to the user]\n"
                f"{tool_results_text}\n"
                f"[End tool results]\n\n"
                f"{payload.message}"
            )

        llm_request = build_llm_request(
            request_id=context.request_id,
            system_prompt=system_prompt,
            user_message=effective_message,
            history=_convert_history(payload),
            temperature=0.3 if clinical_mode else 0.4,
            max_output_tokens=1800 if clinical_mode else 1200,
            metadata={
                "route": "chat",
                "locale": locale,
                "channel": context.channel.value,
                "authenticated": authenticated,
                "safety_level": safety_decision.level.value,
                "response_mode": response_mode,
                "history_count": len(payload.history or []),
                "mode_preference": user_preference,
                "intent_situation_type": intent_context.get("situation_type"),
                "user_id_hash": context.session.user_id_hash,
            },
        )

        llm_result = await services.llm.generate_with_trace(llm_request)

        guarded = await services.output_guard.validate_output_with_rewrite(
            llm_result.response.text,
            locale=locale,
        )

        reply = guarded.final_text

        memory_updated = False
        response_memory_summary = memory_summary
        response_memory_graph_delta = None
        response_memory_graph_snapshot = None

        if memory_allowed:
            graph_update = await _persist_memory_graph_inline(
                payload=payload,
                reply=reply,
                services=services,
                context=context,
                existing_graph=memory_graph or MemoryGraph(user_id_hash=context.session.user_id_hash),
                locale=locale,
            )
            if graph_update is not None:
                memory_updated = True
                response_memory_graph_delta = graph_update["delta"]
                response_memory_graph_snapshot = graph_update["snapshot"]
                response_memory_summary = summary_from_memory_graph(response_memory_graph_snapshot)

        if safety_decision.should_log:
            await _persist_safety_event_inline(
                services=services,
                context=context,
                decision=safety_decision,
                locale=locale,
            )

        if authenticated:
            credit_cost = 2 if clinical_mode else 1
            
            def increment_quota(p: Any) -> Any:
                import time
                now_ts = time.time()
                if now_ts - p.usage.credits_5h_reset_time > 5 * 3600:
                    p.usage.credits_5h_reset_time = now_ts
                    p.usage.total_credits_5h = 0
                    p.usage.pro_last_reset_time = now_ts
                    p.usage.pro_messages_count = 0
    
                if now_ts - p.usage.credits_week_reset_time > 7 * 24 * 3600:
                    p.usage.credits_week_reset_time = now_ts
                    p.usage.total_credits_week = 0
                    
                p.usage.total_credits_5h += credit_cost
                p.usage.total_credits_week += credit_cost
                p.usage.total_messages_count += 1
                if clinical_mode:
                    p.usage.pro_messages_count += 1
                
                return p

            await services.db.atomic_update_user_profile(
                context.session.user_id_hash,
                increment_quota
            )

            if clinical_mode:
                from backend.services.clinical_extractor import extract_clinical_profile
                import copy
                clinical_snapshot = copy.deepcopy(profile.clinical)
                extraction_messages = _convert_history(payload) + [
                    LLMMessage(role=LLMRole.USER, content=effective_message),
                    LLMMessage(role=LLMRole.ASSISTANT, content=reply)
                ]
                req_id = context.request_id
                user_id_hash = context.session.user_id_hash

                async def run_extraction(
                    _msgs=extraction_messages,
                    _clinical=clinical_snapshot,
                    _req_id=req_id,
                    _uid=user_id_hash,
                ):
                    try:
                        updated_clinical = await asyncio.wait_for(
                            extract_clinical_profile(
                                llm=services.llm,
                                messages=_msgs,
                                current_profile=_clinical,
                            ),
                            timeout=15.0,
                        )
                        
                        def update_clinical(p: Any) -> Any:
                            p.clinical = updated_clinical
                            return p
                            
                        await services.db.atomic_update_user_profile(
                            _uid,
                            update_clinical
                        )
                    except Exception as ext_exc:
                        logger.error("Clinical extraction failed for %s: %s", _req_id, type(ext_exc).__name__)

                task = asyncio.create_task(run_extraction())
                _background_tasks.add(task)
                task.add_done_callback(_background_tasks.discard)

        return ChatResponse(
            reply=reply,
            safety=_safety_view(safety_decision),
            provider_used=_provider_label(
                llm_result.response.provider_used,
                rewrite_provider=guarded.rewrite_provider,
            ),
            fallback_count=llm_result.response.fallback_count,
            rag_used=list(rag_result.references),
            memory_updated=memory_updated,
            memory_summary=response_memory_summary.model_dump(mode="json") if response_memory_summary and not response_memory_summary.is_empty() else None,
            memory_graph_delta=response_memory_graph_delta.model_dump(mode="json") if response_memory_graph_delta else None,
            memory_graph_snapshot=response_memory_graph_snapshot.model_dump(mode="json") if response_memory_graph_snapshot else None,
            memory_graph_full_snapshot=bool(response_memory_graph_snapshot),
            request_id=context.request_id,
        )

    except HTTPException:
        raise
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        logger.exception("Chat request failed for %s", context.request_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "chat_failed",
                "message": "Chat request failed",
                "request_id": context.request_id,
            },
        ) from exc


async def _load_chat_profile(
    *,
    services: ServiceContainer,
    context: Any,
    authenticated: bool,
) -> UserProfile:
    """
    Load durable profile only for authenticated users.

    Anonymous users get an ephemeral in-request profile. This prevents guest
    sessions from creating user profile documents in Firestore.
    """
    if not authenticated:
        return UserProfile(
            user_id_hash=context.session.user_id_hash,
            channel=context.session.channel,
        )

    profile_response = await services.db.load_user_profile(context.session.user_id_hash)
    return profile_response.profile


async def _handle_deterministic_safety_response(
    *,
    services: ServiceContainer,
    context: Any,
    locale: str,
    safety_decision: SafetyDecision,
) -> ChatResponse:
    """
    Crisis bypass path.

    This path must not call:
    - LLM generation
    - output guard rewrite
    - RAG planner
    - memory compaction

    Safety event persistence is inline best-effort and never blocks the crisis
    response if storage fails.
    """
    reply = services.safety.render_deterministic_response(safety_decision, locale)

    if safety_decision.should_log:
        await _persist_safety_event_inline(
            services=services,
            context=context,
            decision=safety_decision,
            locale=locale,
        )

    return ChatResponse(
        reply=reply,
        safety=_safety_view(safety_decision),
        provider_used="deterministic_safety",
        fallback_count=0,
        rag_used=[],
        memory_updated=False,
        request_id=context.request_id,
    )


async def _persist_safety_event_inline(
    *,
    services: ServiceContainer,
    context: Any,
    decision: SafetyDecision,
    locale: str,
) -> bool:
    """
    Persist safety event metadata inline best-effort.

    Stores no raw user text. Failure must not block the user response.
    """
    try:
        event = services.safety.build_safety_event(
            request_id=context.request_id,
            user_id_hash=context.session.user_id_hash,
            decision=decision,
            locale=locale,
        )

        await asyncio.wait_for(
            services.db.append_safety_event(event),
            timeout=SAFETY_EVENT_TIMEOUT_SECONDS,
        )

        return True

    except Exception:
        logger.debug("Safety event persistence failed for %s", context.request_id)
        return False




async def _load_or_migrate_memory_graph_inline(
    *,
    services: ServiceContainer,
    user_id_hash: str,
) -> MemoryGraph:
    graph_load = await services.db.load_memory_graph(user_id_hash)

    if graph_load.loaded and graph_load.graph:
        return graph_load.graph

    memory_load = await services.db.load_memory(user_id_hash)

    if memory_load.summary:
        graph = memory_graph_from_summary(memory_load.summary)
        await services.db.save_memory_graph(graph)
        return graph

    return MemoryGraph(user_id_hash=user_id_hash)


async def _persist_memory_graph_inline(
    *,
    payload: ChatRequest,
    reply: str,
    services: ServiceContainer,
    context: Any,
    existing_graph: MemoryGraph,
    locale: str,
) -> dict[str, MemoryGraph] | None:
    """
    Build a Memory V3 delta and merge it into the durable graph.

    Failures are swallowed because memory persistence must never block chat.
    """
    if not bool(context.session.authenticated):
        return None

    try:
        deterministic_delta = await extract_memory_graph_from_text_llm(
            payload.message,
            user_id_hash=context.session.user_id_hash,
            llm_service=services.llm,
        )

        existing_summary = summary_from_memory_graph(existing_graph)
        interactions = build_memory_interactions(
            user_messages=[payload.message],
            assistant_messages=[reply],
        )
        compaction = await asyncio.wait_for(
            services.memory.compact(
                MemoryCompactionRequest(
                    request_id=context.request_id,
                    user_id_hash=context.session.user_id_hash,
                    existing_summary=existing_summary,
                    interactions=interactions,
                    locale=locale,
                    force=False,
                )
            ),
            timeout=MEMORY_COMPACTION_TIMEOUT_SECONDS,
        )

        delta = deterministic_delta
        if compaction.changed:
            compacted_delta = memory_graph_delta_from_summary(
                compaction.summary,
                source=MemorySource.BACKEND_COMPACTION,
            )
            delta = merge_memory_graph(deterministic_delta, compacted_delta)
            delta.full_snapshot = False

        if not delta.atoms:
            return None

        snapshot = merge_memory_graph(existing_graph, delta)
        snapshot = snapshot.model_copy(update={"user_id_hash": context.session.user_id_hash, "full_snapshot": True})

        await asyncio.wait_for(
            services.db.save_memory_graph(snapshot),
            timeout=MEMORY_COMPACTION_TIMEOUT_SECONDS,
        )
        await asyncio.wait_for(
            services.db.save_memory(summary_from_memory_graph(snapshot)),
            timeout=MEMORY_COMPACTION_TIMEOUT_SECONDS,
        )

        return {"delta": delta, "snapshot": snapshot}

    except Exception:
        logger.warning("Memory graph persistence failed for %s", context.request_id, exc_info=True)
        return None



def _maybe_answer_chat_context_question(payload: ChatRequest) -> str | None:
    """
    Deterministic answers for questions about the current chat state.

    LLMs should not estimate message counts. The frontend sends chat history
    with the request, so this route can answer exactly from payload.history.
    """
    message = sanitize_text(payload.message or "", 800)
    lowered = message.lower()

    if not _looks_like_chat_count_question(lowered, message):
        return None

    stats = _chat_history_stats(payload)
    is_arabic = _contains_arabic_text(message)

    if _asks_user_message_count(lowered, message):
        if is_arabic:
            return f"إنت بعت {stats['user_messages']} رسالة في الشات ده لحد دلوقتي."
        return f"You have sent {stats['user_messages']} messages in this chat so far."

    if _asks_assistant_message_count(lowered, message):
        if is_arabic:
            return f"MindPal رد بـ {stats['assistant_messages']} رسالة في الشات ده لحد دلوقتي."
        return f"MindPal has sent {stats['assistant_messages']} messages in this chat so far."

    if is_arabic:
        return (
            f"فيه {stats['total_messages']} رسالة في الشات ده لحد دلوقتي: "
            f"{stats['user_messages']} منك و {stats['assistant_messages']} من MindPal."
        )

    return (
        f"There are {stats['total_messages']} messages in this chat so far: "
        f"{stats['user_messages']} from you and {stats['assistant_messages']} from MindPal."
    )


def _chat_history_stats(payload: ChatRequest) -> dict[str, int]:
    history = list(payload.history or [])

    history_includes_current = _history_includes_current_user_message(payload, history)

    total_messages = len(history) if history_includes_current else len(history) + 1
    user_messages = 0
    assistant_messages = 0

    for item in history:
        role = _history_role(item)

        if role == "user":
            user_messages += 1
        elif role == "assistant":
            assistant_messages += 1

    if not history_includes_current:
        user_messages += 1

    return {
        "total_messages": max(0, total_messages),
        "user_messages": max(0, user_messages),
        "assistant_messages": max(0, assistant_messages),
    }


def _history_includes_current_user_message(payload: ChatRequest, history: list[Any]) -> bool:
    if not history:
        return False

    last = history[-1]

    if _history_role(last) != "user":
        return False

    latest_history_text = sanitize_text(_history_content(last), 2_000).strip()
    current_text = sanitize_text(payload.message or "", 2_000).strip()

    return bool(latest_history_text and current_text and latest_history_text == current_text)


def _history_role(item: Any) -> str:
    role = getattr(item, "role", "")

    value = getattr(role, "value", role)
    raw = sanitize_text(str(value or ""), 80).lower()

    if raw in {"user", "human"}:
        return "user"

    if raw in {"assistant", "mindpal", "bot"}:
        return "assistant"

    return raw


def _history_content(item: Any) -> str:
    for attr in ("content", "text", "message"):
        value = getattr(item, attr, None)

        if value:
            return str(value)

    return ""


def _looks_like_chat_count_question(lowered: str, original: str) -> bool:
    english_hits = (
        "how many messages" in lowered
        or "message count" in lowered
        or "messages in this chat" in lowered
        or "messages were sent" in lowered
        or "messages was been sent" in lowered
        or "how many have i sent" in lowered
        or "how many did i send" in lowered
        or "how many messages did i send" in lowered
        or "how many messages have i sent" in lowered
    )

    arabic_hits = any(
        phrase in original
        for phrase in (
            "كم رسالة",
            "كام رسالة",
            "عدد الرسائل",
            "عدد رسايل",
            "كام مسج",
            "كم مسج",
            "في الشات ده",
            "فى الشات ده",
        )
    )

    return bool(english_hits or arabic_hits)


def _asks_user_message_count(lowered: str, original: str) -> bool:
    return bool(
        "did i send" in lowered
        or "have i sent" in lowered
        or "i sent" in lowered
        or "from me" in lowered
        or "رسائلي" in original
        or "انا بعت" in original
        or "أنا بعت" in original
        or "مني" in original
        or "منّي" in original
    )


def _asks_assistant_message_count(lowered: str, original: str) -> bool:
    return bool(
        "did you send" in lowered
        or "have you sent" in lowered
        or "from you" in lowered
        or "mindpal sent" in lowered
        or "رديت" in original
        or "انت بعت" in original
        or "إنت بعت" in original
        or "من MindPal" in original
    )


def _contains_arabic_text(value: str) -> bool:
    return any("\u0600" <= char <= "\u06ff" for char in value)


def _convert_history(payload: ChatRequest) -> list[LLMMessage]:
    history: list[LLMMessage] = []

    for message in payload.history[-MAX_HISTORY_FOR_LLM:]:
        role = LLMRole.USER if message.role.value == "user" else LLMRole.ASSISTANT
        history.append(
            LLMMessage(
                role=role,
                content=message.content,
            )
        )

    return history


def _resolve_locale(payload: ChatRequest, fallback_locale: str) -> str:
    if payload.metadata.locale and payload.metadata.locale != "auto":
        return payload.metadata.locale
    return fallback_locale or "auto"


def _safety_view(decision: SafetyDecision) -> ChatSafetyView:
    return ChatSafetyView(
        level=decision.level,
        bypass_llm=decision.bypass_llm,
        matched_rules=decision.matched_rules,
        user_visible_category=decision.user_visible_category,
    )


def _build_user_preferences_prompt(profile: UserProfile, metadata: Any | None = None) -> str:
    preferences = profile.preferences

    parts: list[str] = [
        f"communication_style={preferences.communication_style.value}",
    ]

    if preferences.preferred_name:
        parts.append(f"preferred_name={preferences.preferred_name}")

    if preferences.preferred_coping_tools:
        parts.append(
            "preferred_coping_tools="
            + ", ".join(preferences.preferred_coping_tools[:10])
        )

    if preferences.wellness_goals:
        parts.append("wellness_goals=" + ", ".join(preferences.wellness_goals[:10]))

    if preferences.avoided_topics:
        parts.append("avoided_topics=" + ", ".join(preferences.avoided_topics[:10]))

    if preferences.custom_instructions:
        parts.append(f"custom_instructions={preferences.custom_instructions}")

    if metadata:
        if getattr(metadata, "communication_style", None):
            parts.append(f"client_communication_style={metadata.communication_style}")
        if getattr(metadata, "directness", None):
            parts.append(f"client_directness={metadata.directness}")
        if getattr(metadata, "egyptian_arabic_style", None):
            parts.append(f"client_egyptian_arabic_style={metadata.egyptian_arabic_style}")
        if getattr(metadata, "cognitive_structure", None) is not None:
            parts.append(f"client_cognitive_structure={metadata.cognitive_structure}")
        if getattr(metadata, "fast_answers", None) is not None:
            parts.append(f"client_fast_answers={metadata.fast_answers}")
        if getattr(metadata, "custom_instructions", None):
            parts.append(f"client_custom_instructions={metadata.custom_instructions}")

    if hasattr(profile, "clinical") and profile.clinical:
        clinical = profile.clinical
        if clinical.presenting_problems:
            parts.append("presenting_problems=" + ", ".join(clinical.presenting_problems))
        if clinical.suspected_diagnoses:
            parts.append("suspected_diagnoses=" + ", ".join(clinical.suspected_diagnoses))
        if clinical.treatment_plan:
            parts.append(f"treatment_plan={clinical.treatment_plan}")
        if clinical.phq9_history:
            scores = ", ".join(f"{item.score} ({item.date})" for item in clinical.phq9_history[-5:])
            parts.append(f"phq9_history=[{scores}]")
        if clinical.gad7_history:
            scores = ", ".join(f"{item.score} ({item.date})" for item in clinical.gad7_history[-5:])
            parts.append(f"gad7_history=[{scores}]")

    return sanitize_text("\n".join(parts), MAX_USER_PREFS_PROMPT_CHARS)


def _provider_label(provider_used: str, *, rewrite_provider: str | None) -> str:
    base = sanitize_text(provider_used or "unknown", 80)

    if rewrite_provider:
        rewrite = sanitize_text(rewrite_provider, 80)
        return f"{base}+rewrite:{rewrite}"

    return base


# ═══════════════════════════════════════════════════════════════
# Tool Pre-Execution
# ═══════════════════════════════════════════════════════════════

_TIME_TRIGGERS = (
    "what time", "what's the time", "what date", "what day", "what's the date",
    "الساعة كام", "الساعة", "اليوم ايه", "النهاردة", "كام الساعة",
    "current time", "current date", "today's date",
)

_MEMORY_TRIGGERS = (
    "do you remember", "what do you know about me", "what did i tell you",
    "my name", "who am i", "فاكر", "تفتكر", "بتعرف ايه عني",
    "remember when", "you know about",
)

_WEB_SEARCH_TRIGGERS = (
    "search for", "look up", "what's happening", "current news",
    "latest", "who is", "what is", "دور على", "ابحث عن",
)


async def _pre_execute_tools(
    user_message: str,
    registry: Any,
    tool_context: Any,
) -> str:
    """
    Pre-execute tools when the user's message clearly needs them.

    Returns formatted tool results text to prepend to the user message,
    or empty string if no pre-execution was needed.
    """
    if not user_message:
        return ""

    lowered = user_message.lower()
    results_parts: list[str] = []

    # Always inject current time for time-related queries
    if any(trigger in lowered for trigger in _TIME_TRIGGERS):
        try:
            time_result = await registry.execute("current_time", {}, tool_context)
            if time_result.ok:
                local_info = time_result.data.get("local", {})
                utc_info = time_result.data.get("utc", {})
                results_parts.append(
                    f"Current time: {local_info.get('datetime', utc_info.get('datetime', 'unknown'))} "
                    f"({local_info.get('day_of_week', utc_info.get('day_of_week', ''))}) "
                    f"[{local_info.get('timezone', 'UTC')}]"
                )
        except Exception:
            pass

    # Memory search for "do you remember" type queries
    if any(trigger in lowered for trigger in _MEMORY_TRIGGERS):
        try:
            # Extract the search query from the user's message
            query_part = lowered
            for trigger in _MEMORY_TRIGGERS:
                if trigger in lowered:
                    idx = lowered.index(trigger) + len(trigger)
                    query_part = user_message[idx:].strip().rstrip("?").strip()
                    break

            memory_result = await registry.execute(
                "search_memory",
                {"query": query_part or user_message[:100]},
                tool_context,
            )
            if memory_result.ok and memory_result.data.get("facts"):
                facts = memory_result.data["facts"][:5]
                results_parts.append(
                    f"Memory search results for '{query_part or 'general'}':\n"
                    + "\n".join(f"- {fact}" for fact in facts)
                )
        except Exception:
            pass

    # Web search for current information queries
    if any(trigger in lowered for trigger in _WEB_SEARCH_TRIGGERS):
        try:
            # Extract search query
            query_part = user_message
            for trigger in _WEB_SEARCH_TRIGGERS:
                if trigger in lowered:
                    idx = lowered.index(trigger) + len(trigger)
                    extracted = user_message[idx:].strip().rstrip("?").strip()
                    if extracted:
                        query_part = extracted
                    break

            search_result = await registry.execute(
                "web_search",
                {"query": query_part[:150]},
                tool_context,
            )
            if search_result.ok and search_result.data.get("results"):
                web_results = search_result.data["results"][:3]
                lines = [f"Web search results for '{query_part[:80]}':"]
                for r in web_results:
                    lines.append(f"- {r.get('title', '')}: {r.get('snippet', '')} [{r.get('url', '')}]")
                results_parts.append("\n".join(lines))
        except Exception:
            pass

    return "\n\n".join(results_parts)
