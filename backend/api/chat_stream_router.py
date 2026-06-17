# backend/api/chat_stream_router.py

"""
SSE streaming chat endpoint.

Reuses shared logic from chat_router for safety, memory, profile loading.
Streams LLM tokens as Server-Sent Events, then sends metadata as a final event.
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import time
from typing import Any

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import StreamingResponse

from backend.api.dependencies import RequestContextDep, ServiceContainer, ServicesDep
from backend.api.chat_router import (
    _resolve_locale,
    _maybe_answer_chat_context_question,
    _load_chat_profile,
    _load_or_migrate_memory_graph_inline,
    _build_user_preferences_prompt,
    _convert_history,
    _persist_memory_graph_inline,
    _persist_safety_event_inline,
    _safety_view,
    _provider_label,
)
from backend.core.prompts import build_intent_context, build_system_prompt, infer_response_mode_for_preference
from backend.models.chat import ChatRequest, LLMMessage, LLMRole
from backend.models.memory import MemoryGraph, summary_from_memory_graph
from backend.services.llm_service import build_llm_request
from backend.services.memory_graph_service import build_memory_graph_prompt
from backend.services.telemetry_service import TelemetryService
from backend.services.clinical_extractor import extract_clinical_profile
from backend.tools import ToolContext, build_default_registry
from backend.api.chat_router import _pre_execute_tools


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["chat_stream"])

CLINICAL_EXTRACTION_TIMEOUT_SECONDS = 30.0

# Lazy singleton tool registry
_tool_registry = None


def _get_tool_registry():
    global _tool_registry
    if _tool_registry is None:
        _tool_registry = build_default_registry()
    return _tool_registry


@router.post("/chat/stream")
async def chat_stream(
    payload: ChatRequest,
    services: ServicesDep,
    context: RequestContextDep,
):
    locale = _resolve_locale(payload, context.locale)
    authenticated = bool(context.session.authenticated)
    start_time = time.perf_counter()

    try:
        safety_decision = await services.safety.classify_input_with_context(
            payload.message,
            locale=locale,
            memory_summary=None,
            channel=context.channel.value,
        )

        if safety_decision.bypass_llm:
            reply = services.safety.render_deterministic_response(safety_decision, locale)
            async def mock_safety_stream():
                yield f"data: {json.dumps({'text': reply})}\n\n"
                if safety_decision.should_log:
                    await _persist_safety_event_inline(
                        services=services,
                        context=context,
                        decision=safety_decision,
                        locale=locale,
                    )
                yield f"data: {json.dumps({'type': 'metadata', 'provider_used': 'deterministic_safety'})}\n\n"
            return StreamingResponse(mock_safety_stream(), media_type="text/event-stream")

        deterministic_context_reply = _maybe_answer_chat_context_question(payload)
        if deterministic_context_reply:
            async def mock_context_stream():
                yield f"data: {json.dumps({'text': deterministic_context_reply})}\n\n"
                yield f"data: {json.dumps({'type': 'metadata', 'provider_used': 'deterministic_chat_context'})}\n\n"
            return StreamingResponse(mock_context_stream(), media_type="text/event-stream")

        profile = await _load_chat_profile(
            services=services,
            context=context,
            authenticated=authenticated,
        )

        memory_summary = None
        memory_graph = None
        memory_prompt = ""

        memory_allowed = bool(authenticated and profile.preferences.safety.allow_memory)

        if memory_allowed:
            memory_graph = await _load_or_migrate_memory_graph_inline(
                services=services,
                user_id_hash=context.session.user_id_hash,
            )
            memory_summary = summary_from_memory_graph(memory_graph)
            memory_prompt = build_memory_graph_prompt(memory_graph)

        rag_tags = services.safety.rag_tags_for_decision(safety_decision)
        intent_context = build_intent_context(payload.message, locale=locale)

        user_preference = payload.metadata.mode or ""
        clinical_mode = payload.metadata.model == "pro"
        quota_exceeded = False
        credit_cost = 2 if clinical_mode else 1

        # ── Unified dual-window credit check ──
        if authenticated:
            now_ts = time.time()

            # Reset 5-hour window if expired
            if now_ts - profile.usage.credits_5h_reset_time > 5 * 3600:
                profile.usage.credits_5h_reset_time = now_ts
                profile.usage.total_credits_5h = 0
                # Also reset legacy pro counter
                profile.usage.pro_last_reset_time = now_ts
                profile.usage.pro_messages_count = 0

            # Reset 1-week window if expired
            if now_ts - profile.usage.credits_week_reset_time > 7 * 24 * 3600:
                profile.usage.credits_week_reset_time = now_ts
                profile.usage.total_credits_week = 0

            # Check both windows
            limit_5h = 50
            limit_week = 500
            if (profile.usage.total_credits_5h + credit_cost > limit_5h or
                    profile.usage.total_credits_week + credit_cost > limit_week):
                if clinical_mode:
                    clinical_mode = False  # Downgrade to standard
                quota_exceeded = True
            else:
                profile.usage.total_credits_5h += credit_cost
                profile.usage.total_credits_week += credit_cost
                profile.usage.total_messages_count += 1
                # Legacy compat
                if clinical_mode:
                    profile.usage.pro_messages_count += 1

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
                "route": "chat_stream",
                "locale": locale,
                "channel": context.channel.value,
                "authenticated": authenticated,
                "safety_level": safety_decision.level.value,
                "response_mode": response_mode,
                "history_count": len(payload.history or []),
                "mode_preference": user_preference,
                "intent_situation_type": intent_context.get("situation_type"),
                "tools_pre_executed": bool(tool_results_text),
            },
        )

        async def stream_generator():
            full_text = []
            try:
                async for chunk in services.llm.generate_stream(llm_request):
                    full_text.append(chunk)
                    yield f"data: {json.dumps({'text': chunk})}\n\n"
                    
                final_reply = "".join(full_text)

                memory_updated = False
                response_memory_summary = memory_summary
                response_memory_graph_delta = None
                response_memory_graph_snapshot = None

                yield f"data: {json.dumps({'type': 'status', 'status': 'text_finished'})}\n\n"

                if memory_allowed:
                    graph_update = await _persist_memory_graph_inline(
                        payload=payload,
                        reply=final_reply,
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

                # Final metadata chunk
                metadata: dict[str, Any] = {
                    'type': 'metadata',
                    'provider_used': 'streaming',
                    'fallback_count': 0,
                    'rag_used': [ref.model_dump() for ref in rag_result.references],
                    'memory_updated': memory_updated,
                    'safety': _safety_view(safety_decision).model_dump()
                }
                if response_memory_summary and not response_memory_summary.is_empty():
                    metadata['memory_summary'] = response_memory_summary.model_dump(mode="json")
                if response_memory_graph_delta:
                    metadata['memory_graph_delta'] = response_memory_graph_delta.model_dump(mode="json")
                if response_memory_graph_snapshot:
                    metadata['memory_graph_snapshot'] = response_memory_graph_snapshot.model_dump(mode="json")
                if quota_exceeded:
                    metadata['quota_exceeded'] = True

                # Always emit usage so frontend can display quota info
                if authenticated:
                    now_ts_meta = time.time()
                    metadata['usage'] = {
                        'credits_5h': profile.usage.total_credits_5h,
                        'limit_5h': 50,
                        'reset_5h_seconds': max(0, int((profile.usage.credits_5h_reset_time + 5 * 3600) - now_ts_meta)),
                        'credits_week': profile.usage.total_credits_week,
                        'limit_week': 500,
                        'reset_week_seconds': max(0, int((profile.usage.credits_week_reset_time + 7 * 24 * 3600) - now_ts_meta)),
                        'total_messages': profile.usage.total_messages_count,
                    }
                    # Legacy compat
                    metadata['pro_usage'] = {
                        'count': profile.usage.pro_messages_count,
                        'limit': 40,
                        'reset_in_seconds': max(0, int((profile.usage.pro_last_reset_time + 5 * 3600) - now_ts_meta)),
                    }

                yield f"data: {json.dumps(metadata)}\n\n"

                # Telemetry
                telemetry = TelemetryService(context.session, profile)
                if hasattr(rag_result, "references"):
                    telemetry.log_rag_retrieval(
                        num_results=len(rag_result.references),
                        top_score=rag_result.references[0].score if rag_result.references else 0.0,
                        fallback_triggered=False
                    )
                
                prompt_tokens_est = len(system_prompt + payload.message) // 4
                comp_tokens_est = len(final_reply) // 4
                telemetry.log_llm_usage(provider="streaming", prompt_tokens=prompt_tokens_est, completion_tokens=comp_tokens_est)
                telemetry.log_latency("chat_stream_full", (time.perf_counter() - start_time) * 1000)

                # Save profile (captures quota increment)
                if authenticated:
                    await services.db.save_user_profile(profile)

                # Clinical extraction in background (with timeout guard)
                if clinical_mode and authenticated:
                    clinical_snapshot = copy.deepcopy(profile.clinical)
                    extraction_messages = [
                        msg for msg in llm_request.messages
                        if msg.role != LLMRole.SYSTEM
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
                                timeout=CLINICAL_EXTRACTION_TIMEOUT_SECONDS,
                            )
                            # Re-load profile to avoid overwriting newer quota counts
                            fresh_resp = await services.db.load_user_profile(_uid)
                            if fresh_resp and fresh_resp.profile:
                                fresh_resp.profile.clinical = updated_clinical
                                await services.db.save_user_profile(fresh_resp.profile)
                            else:
                                profile.clinical = updated_clinical
                                await services.db.save_user_profile(profile)
                        except Exception as ext_exc:
                            logger.error("Clinical extraction failed for %s: %s", _req_id, type(ext_exc).__name__)

                    asyncio.create_task(run_extraction())

            except Exception:
                # SECURITY: Never send raw exception text to the client.
                logger.exception("Stream generation failed for %s", context.request_id)
                yield f"data: {json.dumps({'error': 'Stream generation failed. Please try again.'})}\n\n"

        return StreamingResponse(stream_generator(), media_type="text/event-stream")

    except Exception as exc:
        logger.exception("Chat stream setup failed for %s", context.request_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "chat_stream_failed",
                "message": "Chat stream request failed",
                "request_id": context.request_id,
            },
        ) from exc
