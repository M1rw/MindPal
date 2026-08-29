# backend/features/chat/routes.py

"""
Standard chat request/response endpoints.
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from backend.api.dependencies import (
    RequestContextDep,
    ServicesDep,
    assert_authenticated,
    get_timezone,
    http_error_from_app_error,
)
from backend.core.errors import AppError
from backend.core.security import sanitize_text
from .schemas import ChatRequest, ChatResponse

router = APIRouter(prefix="/api", tags=["chat"])
logger = logging.getLogger(__name__)


@router.post("/chat", response_model=ChatResponse)
async def chat(
    payload: ChatRequest,
    services: ServicesDep,
    context: RequestContextDep,
    header_timezone: Annotated[str, Depends(get_timezone)] = "UTC",
) -> ChatResponse:
    """Production chat endpoint with safety, memory, RAG, and LLM orchestration."""
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

    try:
        return await services.chat.handle(
            request=payload,
            user_id_hash=context.session.user_id_hash,
            authenticated=authenticated,
            locale=locale,
            channel=context.channel if isinstance(context.channel, str) else context.channel.value,
            timezone=user_timezone,
            request_id=context.request_id,
        )
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        logger.error("chat_unhandled_error request_id=%s error=%s", context.request_id, type(exc).__name__)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "chat_failed", "message": "Chat service temporarily unavailable", "request_id": context.request_id},
        ) from exc
