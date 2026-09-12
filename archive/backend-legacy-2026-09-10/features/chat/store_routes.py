# backend/features/chat/store_routes.py

"""
Chat session storage and history management endpoints.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

from backend.api.dependencies import (
    AuthenticatedRequestContextDep,
    ServicesDep,
    assert_authenticated,
    http_error_from_app_error,
)
from backend.core.errors import AppError
from backend.core.security import sanitize_text
from .schemas import ChatMessage, ChatSession, ChatStoreRequest

router = APIRouter(prefix="/api/chat", tags=["chat-store"])
logger = logging.getLogger(__name__)


class SessionListResponse(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    sessions: list[ChatSession]
    total: int = 0


@router.post("/sessions")
async def create_or_store_session(
    payload: ChatStoreRequest,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> dict[str, Any]:
    assert_authenticated(context)
    try:
        session_id = sanitize_text(payload.session_id, 120)
        await services.db.store_chat_session(
            user_id_hash=context.session.user_id_hash,
            session_id=session_id,
            messages=[m.model_dump() for m in payload.messages],
        )
        return {"session_id": session_id, "message_count": len(payload.messages), "stored": True}
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "session_store_failed", "message": "Failed to store session", "request_id": context.request_id},
        ) from exc


@router.get("/sessions")
async def list_sessions(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> SessionListResponse:
    assert_authenticated(context)
    try:
        sessions = await services.db.list_chat_sessions(context.session.user_id_hash)
        return SessionListResponse(sessions=sessions, total=len(sessions))
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "session_list_failed", "message": "Failed to list sessions", "request_id": context.request_id},
        ) from exc


@router.delete("/sessions/{session_id}")
async def delete_session(
    session_id: str,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> dict[str, bool]:
    assert_authenticated(context)
    clean_id = sanitize_text(session_id, 120)
    try:
        await services.db.delete_chat_session(
            user_id_hash=context.session.user_id_hash,
            session_id=clean_id,
        )
        return {"deleted": True}
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "session_delete_failed", "message": "Failed to delete session", "request_id": context.request_id},
        ) from exc
