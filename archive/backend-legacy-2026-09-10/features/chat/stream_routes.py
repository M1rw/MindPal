# backend/features/chat/stream_routes.py

"""
Server-Sent Events (SSE) streaming chat endpoints.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Annotated, AsyncGenerator

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse

from backend.api.dependencies import (
    RequestContextDep,
    ServicesDep,
    assert_authenticated,
    get_timezone,
    http_error_from_app_error,
)
from backend.core.errors import AppError
from backend.core.security import sanitize_text
from .schemas import ChatRequest

router = APIRouter(prefix="/api", tags=["chat-stream"])
logger = logging.getLogger(__name__)

_SSE_CONTENT_TYPE = "text/event-stream"
_SSE_HEADERS = {
    "Cache-Control": "no-cache, no-store",
    "X-Accel-Buffering": "no",
    "Connection": "keep-alive",
}


@router.post("/chat/stream")
async def chat_stream(
    payload: ChatRequest,
    services: ServicesDep,
    context: RequestContextDep,
    header_timezone: Annotated[str, Depends(get_timezone)] = "UTC",
) -> StreamingResponse:
    """SSE streaming chat — emits SSE delta events as tokens arrive."""
    if services.settings.REQUIRE_AUTH_FOR_PROVIDER_CALLS:
        assert_authenticated(context)

    user_timezone = payload.metadata.timezone or header_timezone or "UTC"
    locale = payload.metadata.locale or context.locale or "auto"
    authenticated = bool(context.session.authenticated)

    await services.rate_limits.consume(
        scope="chat",
        subject=context.session.user_id_hash,
        limit=services.settings.CHAT_RATE_LIMIT_PER_MINUTE,
        window_seconds=60,
    )

    async def _event_generator() -> AsyncGenerator[bytes, None]:
        try:
            async for chunk in services.llm.stream_complete(
                messages=[{"role": m.role.value, "content": m.content} for m in payload.messages[-30:]],
                request_id=context.request_id,
                metadata={"locale": locale, "channel": context.channel},
            ):
                token = sanitize_text(str(chunk or ""), 2_000)
                if token:
                    event = f"data: {json.dumps({'delta': token}, ensure_ascii=False)}\n\n"
                    yield event.encode("utf-8")

            done_event = f"data: {json.dumps({'done': True, 'request_id': context.request_id})}\n\n"
            yield done_event.encode("utf-8")

        except asyncio.CancelledError:
            logger.debug("chat_stream_cancelled request_id=%s", context.request_id)
        except Exception as exc:
            logger.error("chat_stream_error request_id=%s error=%s", context.request_id, type(exc).__name__)
            err_event = f"data: {json.dumps({'error': 'stream_failed', 'request_id': context.request_id})}\n\n"
            yield err_event.encode("utf-8")

    return StreamingResponse(
        _event_generator(),
        media_type=_SSE_CONTENT_TYPE,
        headers=_SSE_HEADERS,
    )
