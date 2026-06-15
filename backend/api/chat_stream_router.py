# backend/api/chat_stream_router.py

from __future__ import annotations

import asyncio
import json
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
from backend.models.chat import ChatRequest
from backend.models.memory_v3 import MemoryGraph, summary_from_memory_graph
from backend.services.llm_service import build_llm_request
from backend.services.memory_graph_service import build_memory_graph_prompt
from backend.services.telemetry_service import TelemetryService
import time

router = APIRouter(prefix="/api", tags=["chat_stream"])

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

        system_prompt = build_system_prompt(
            memory_prompt,
            list(rag_result.prompt_grounding),
            locale,
            response_mode=response_mode,
            safety_level=safety_decision.level.value,
            channel=context.channel.value,
            user_preferences=_build_user_preferences_prompt(profile, payload.metadata),
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
                "authenticated": authenticated,
                "safety_level": safety_decision.level.value,
                "response_mode": response_mode,
                "history_count": len(payload.history or []),
                "mode_preference": user_preference,
                "intent_situation_type": intent_context.get("situation_type"),
            },
        )

        async def stream_generator():
            full_text = []
            try:
                # We skip output guard rewriting here for streaming,
                # because we are streaming tokens directly.
                async for chunk in services.llm.generate_stream(llm_request):
                    full_text.append(chunk)
                    yield f"data: {json.dumps({'text': chunk})}\n\n"
                    
                final_reply = "".join(full_text)

                memory_updated = False
                response_memory_summary = memory_summary
                response_memory_graph_delta = None
                response_memory_graph_snapshot = None

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
                metadata = {
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

                yield f"data: {json.dumps(metadata)}\n\n"

                # Telemetry Tracking (Component 4)
                telemetry = TelemetryService(context.session, profile)
                if hasattr(rag_result, "references"):
                    telemetry.log_rag_retrieval(
                        num_results=len(rag_result.references),
                        top_score=rag_result.references[0].score if rag_result.references else 0.0,
                        fallback_triggered=False
                    )
                
                # We do not have token count for stream currently, so we use string length approximations
                prompt_tokens_est = len(system_prompt + payload.message) // 4
                comp_tokens_est = len(final_reply) // 4
                telemetry.log_llm_usage(provider="streaming", prompt_tokens=prompt_tokens_est, completion_tokens=comp_tokens_est)
                telemetry.log_latency("chat_stream_full", (time.perf_counter() - start_time) * 1000)

            except Exception as exc:
                yield f"data: {json.dumps({'error': str(exc)})}\n\n"

        return StreamingResponse(stream_generator(), media_type="text/event-stream")

    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "chat_stream_failed",
                "message": "Chat stream request failed",
                "request_id": context.request_id,
            },
        ) from exc
