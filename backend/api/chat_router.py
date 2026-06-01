# backend/api/chat_router.py

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, status

from backend.api.dependencies import RequestContextDep, ServiceContainer, ServicesDep
from backend.core.errors import AppError
from backend.core.prompts import build_system_prompt, infer_response_mode
from backend.core.security import sanitize_text
from backend.models.chat import (
    ChatRequest,
    ChatResponse,
    ChatSafetyView,
    LLMMessage,
    LLMRole,
)
from backend.models.memory import MemoryCompactionRequest
from backend.models.safety import SafetyDecision
from backend.models.user import UserProfile
from backend.services.llm_service import build_llm_request
from backend.services.memory_service import build_memory_interactions
from backend.tasks.background_jobs import (
    BackgroundJobStatus,
    enqueue_memory_compaction,
    enqueue_safety_event,
    get_background_job_runner,
)


router = APIRouter(prefix="/api", tags=["chat"])

MAX_HISTORY_FOR_LLM = 30
MAX_USER_PREFS_PROMPT_CHARS = 1_200


@router.post("/chat", response_model=ChatResponse)
async def chat(
    payload: ChatRequest,
    services: ServicesDep,
    context: RequestContextDep,
) -> ChatResponse:
    """
    Main MindPal chat route.

    Required safety order:
    1. classify input before LLM response generation
    2. deterministic crisis bypass if required
    3. load profile/memory only after safety decision
    4. retrieve RAG grounding
    5. generate LLM answer
    6. output-guard generated answer before returning
    7. queue non-critical memory/log persistence after guarded response
    """
    locale = _resolve_locale(payload, context.locale)

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

        profile_response = await services.db.load_user_profile(context.session.user_id_hash)
        profile = profile_response.profile

        memory_summary = None
        memory_prompt = ""

        if profile.preferences.safety.allow_memory:
            memory_load = await services.db.load_memory(context.session.user_id_hash)
            memory_summary = memory_load.summary
            memory_prompt = services.memory.build_prompt_summary(memory_summary)

        rag_tags = services.safety.rag_tags_for_decision(safety_decision)
        response_mode = infer_response_mode(
            safety_level=safety_decision.level.value,
            rag_tags=rag_tags,
            user_message=payload.message,
        )

        rag_result = await services.rag.retrieve_contextual(
            payload.message,
            safety_tags=rag_tags,
            locale=locale,
            memory_summary=memory_prompt,
            max_results=4,
        )

        system_prompt = build_system_prompt(
            memory_prompt,
            list(rag_result.prompt_grounding),
            locale,
            response_mode=response_mode,
            safety_level=safety_decision.level.value,
            channel=context.channel.value,
            user_preferences=_build_user_preferences_prompt(profile),
        )

        llm_request = build_llm_request(
            request_id=context.request_id,
            system_prompt=system_prompt,
            user_message=payload.message,
            history=_convert_history(payload),
            temperature=0.4,
            max_output_tokens=900,
            metadata={
                "route": "chat",
                "locale": locale,
                "channel": context.channel.value,
                "safety_level": safety_decision.level.value,
                "response_mode": response_mode,
            },
        )

        llm_result = await services.llm.generate_with_trace(llm_request)

        guarded = await services.output_guard.validate_output_with_rewrite(
            llm_result.response.text,
            locale=locale,
        )

        reply = guarded.final_text

        memory_job_accepted = False

        if profile.preferences.safety.allow_memory:
            memory_job_accepted = await _queue_memory_compaction(
                payload=payload,
                reply=reply,
                services=services,
                context=context,
                existing_summary=memory_summary,
                locale=locale,
            )

        if safety_decision.should_log:
            await _queue_safety_event(
                services=services,
                context=context,
                decision=safety_decision,
                locale=locale,
            )

        return ChatResponse(
            reply=reply,
            safety=_safety_view(safety_decision),
            provider_used=_provider_label(
                llm_result.response.provider_used,
                rewrite_provider=guarded.rewrite_provider,
            ),
            fallback_count=llm_result.response.fallback_count,
            rag_used=list(rag_result.references),
            memory_updated=memory_job_accepted,
            request_id=context.request_id,
        )

    except HTTPException:
        raise
    except AppError as exc:
        raise _http_error_from_app_error(exc) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "chat_failed",
                "message": "Chat request failed",
                "request_id": context.request_id,
            },
        ) from exc


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

    Safety event persistence is queued best-effort after deterministic response
    is rendered.
    """
    reply = services.safety.render_deterministic_response(safety_decision, locale)

    if safety_decision.should_log:
        await _queue_safety_event(
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


async def _queue_safety_event(
    *,
    services: ServiceContainer,
    context: Any,
    decision: SafetyDecision,
    locale: str,
) -> bool:
    """
    Queue safety event persistence best-effort.

    Failure to queue/persist a safety event must not block the user response.
    """
    try:
        event = services.safety.build_safety_event(
            request_id=context.request_id,
            user_id_hash=context.session.user_id_hash,
            decision=decision,
            locale=locale,
        )

        result = await enqueue_safety_event(
            get_background_job_runner(),
            services=services,
            event=event,
        )

        return result.status != BackgroundJobStatus.DROPPED

    except Exception:
        return False


async def _queue_memory_compaction(
    *,
    payload: ChatRequest,
    reply: str,
    services: ServiceContainer,
    context: Any,
    existing_summary: Any,
    locale: str,
) -> bool:
    """
    Queue memory compaction best-effort.

    ChatResponse.memory_updated means the memory job was accepted or completed
    inline; it does not guarantee durable persistence if the process exits before
    the in-process queue drains.
    """
    try:
        interactions = build_memory_interactions(
            user_messages=[payload.message],
            assistant_messages=[reply],
        )

        result = await enqueue_memory_compaction(
            get_background_job_runner(),
            services=services,
            request=MemoryCompactionRequest(
                request_id=context.request_id,
                user_id_hash=context.session.user_id_hash,
                existing_summary=existing_summary,
                interactions=interactions,
                locale=locale,
                force=False,
            ),
            save=True,
        )

        return result.status != BackgroundJobStatus.DROPPED

    except Exception:
        return False


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


def _build_user_preferences_prompt(profile: UserProfile) -> str:
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

    return sanitize_text("\n".join(parts), MAX_USER_PREFS_PROMPT_CHARS)


def _provider_label(provider_used: str, *, rewrite_provider: str | None) -> str:
    base = sanitize_text(provider_used or "unknown", 80)

    if rewrite_provider:
        rewrite = sanitize_text(rewrite_provider, 80)
        return f"{base}+rewrite:{rewrite}"

    return base


def _http_error_from_app_error(exc: AppError) -> HTTPException:
    status_code = getattr(exc, "status_code", None) or status.HTTP_500_INTERNAL_SERVER_ERROR
    code = getattr(exc, "code", None) or exc.__class__.__name__
    message = sanitize_text(str(exc), 500) or "Application error"
    details = getattr(exc, "details", None) or {}

    return HTTPException(
        status_code=status_code,
        detail={
            "code": code,
            "message": message,
            "details": details,
        },
    )