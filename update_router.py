import sys

content = open('backend/api/chat_router.py', encoding='utf-8').read()

prep_code = """
async def _prepare_chat_context(
    payload: ChatRequest,
    services: ServiceContainer,
    context: Any,
    locale: str,
    authenticated: bool,
):
    safety_decision = await services.safety.classify_input_with_context(
        payload.message,
        locale=locale,
        memory_summary=None,
        channel=context.channel.value,
    )

    if safety_decision.bypass_llm:
        return {'safety_decision': safety_decision, 'bypass': True}

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

    return {
        'safety_decision': safety_decision,
        'bypass': False,
        'memory_allowed': memory_allowed,
        'memory_graph': memory_graph,
        'memory_summary': memory_summary,
        'rag_result': rag_result,
        'llm_request': llm_request,
    }

async def _chat_stream_generator(
    payload: ChatRequest,
    services: ServiceContainer,
    context: Any,
    locale: str,
    authenticated: bool,
    prep_data: dict,
):
    import json
    
    safety_decision = prep_data['safety_decision']
    if prep_data['bypass']:
        reply = services.safety.render_deterministic_response(safety_decision, locale)
        yield f"data: {{json.dumps({'text': reply})}}\n\n"
        if safety_decision.should_log:
            await _persist_safety_event_inline(
                services=services,
                context=context,
                decision=safety_decision,
                locale=locale,
            )
        yield f"data: {{json.dumps({'type': 'metadata', 'provider_used': 'deterministic_safety'})}}\n\n"
        return

    llm_request = prep_data['llm_request']
    memory_allowed = prep_data['memory_allowed']
    memory_graph = prep_data['memory_graph']
    memory_summary = prep_data['memory_summary']
    rag_result = prep_data['rag_result']

    full_text = []
    try:
        async for chunk in services.llm.generate_stream(llm_request):
            full_text.append(chunk)
            yield f"data: {{json.dumps({'text': chunk})}}\n\n"
            
        final_reply = "".join(full_text)
        
        # Now run memory compaction
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
            
        # Metadata chunk at end
        metadata = {
            'type': 'metadata',
            'provider_used': 'streaming',
            'fallback_count': 0,
            'rag_used': [ref.model_dump() for ref in rag_result.references],
            'memory_updated': memory_updated,
        }
        if response_memory_summary and not response_memory_summary.is_empty():
            metadata['memory_summary'] = response_memory_summary.model_dump(mode="json")
        if response_memory_graph_delta:
            metadata['memory_graph_delta'] = response_memory_graph_delta.model_dump(mode="json")
            
        yield f"data: {{json.dumps(metadata)}}\n\n"

    except Exception as exc:
        yield f"data: {{json.dumps({'error': str(exc)})}}\n\n"

@router.post("/chat/stream")
async def chat_stream_route(
    payload: ChatRequest,
    services: ServicesDep,
    context: RequestContextDep,
):
    locale = _resolve_locale(payload, context.locale)
    authenticated = bool(context.session.authenticated)

    deterministic_context_reply = _maybe_answer_chat_context_question(payload)
    if deterministic_context_reply:
        import json
        async def mock_stream():
            yield f"data: {{json.dumps({'text': deterministic_context_reply})}}\n\n"
        return StreamingResponse(mock_stream(), media_type="text/event-stream")

    prep_data = await _prepare_chat_context(payload, services, context, locale, authenticated)
    
    return StreamingResponse(
        _chat_stream_generator(payload, services, context, locale, authenticated, prep_data),
        media_type="text/event-stream"
    )

"""

with open('backend/api/chat_router.py', 'w', encoding='utf-8') as f:
    content = content.replace('from fastapi import APIRouter, HTTPException, status', 'from fastapi import APIRouter, HTTPException, status\nfrom fastapi.responses import StreamingResponse\nimport json')
    content = content.replace('async def _load_chat_profile(', prep_code + '\n\nasync def _load_chat_profile(')
    f.write(content)
