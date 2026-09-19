# backend/http/chat.py — Thin HTTP adapter for streaming chat

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from contextlib import aclosing
from datetime import datetime
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Header, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator

from backend.domain.chat.history import MAX_HISTORY_FOR_LLM
from backend.domain.chat.orchestrator import ChatOrchestrator
from backend.domain.identity.identity import verify_auth_header
from backend.domain.quota.quota import peer_network_id

router = APIRouter()
orchestrator = ChatOrchestrator()
logger = logging.getLogger("mindpal.chat")

# Everything below is attacker-controlled. Without ceilings, one request can pin
# a worker on regex scanning, blow past the provider's context window, and bill
# a full turn's tokens for a single credit.
MAX_MESSAGE_CHARS = 16_000
MAX_HISTORY_TURNS = MAX_HISTORY_FOR_LLM * 2  # prior turns; the orchestrator slices again
MAX_HISTORY_TURN_CHARS = 8_000
MAX_TELEMETRY_KEYS = 32
MAX_PERSONALIZATION_KEYS = 32
MAX_NESTED_VALUE_CHARS = 200
_ALLOWED_MODELS = frozenset({"standard", "pro"})


def _bounded_flat_map(value: Optional[Dict[str, Any]], *, limit: int, label: str) -> Optional[Dict[str, Any]]:
    """Accept a small flat scalar map. Nested blobs are neither read nor stored."""
    if value is None:
        return None
    if len(value) > limit:
        raise ValueError(f"{label} supports at most {limit} keys")
    cleaned: Dict[str, Any] = {}
    for key, item in value.items():
        name = str(key).strip()[:64]
        if not name:
            continue
        if item is None or isinstance(item, (bool, int, float)):
            cleaned[name] = item
        elif isinstance(item, str):
            cleaned[name] = item[:MAX_NESTED_VALUE_CHARS]
    return cleaned


class ChatHistoryTurn(BaseModel):
    role: str = Field(max_length=32)
    content: str = Field(default="", max_length=MAX_HISTORY_TURN_CHARS)
    text: Optional[str] = Field(default=None, max_length=MAX_HISTORY_TURN_CHARS)

    def body(self) -> str:
        return (self.content or self.text or "").strip()


class ClientLocation(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    accuracy_m: Optional[float] = Field(default=None, ge=0, le=100_000)


class ClientContext(BaseModel):
    timezone: Optional[str] = Field(default=None, max_length=64)
    locale: Optional[str] = Field(default=None, max_length=32)
    location: Optional[ClientLocation] = None

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value: Optional[str]) -> Optional[str]:
        if not value:
            return None
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            return None
        return value


class ChatStreamPayload(BaseModel):
    message: str = Field(max_length=MAX_MESSAGE_CHARS)
    history: List[ChatHistoryTurn] = Field(default_factory=list, max_length=MAX_HISTORY_TURNS)
    session_id: Optional[str] = Field(default=None, max_length=128)
    model: Optional[str] = "standard"
    telemetry: Optional[Dict[str, Any]] = None
    personalization: Optional[Dict[str, Any]] = None
    client_context: Optional[ClientContext] = None

    @field_validator("message")
    @classmethod
    def strip_message(cls, value: str) -> str:
        text = (value or "").strip()
        if not text:
            raise ValueError("message must not be empty")
        return text

    @field_validator("model")
    @classmethod
    def known_model(cls, value: Optional[str]) -> str:
        tier = str(value or "standard").strip().lower()
        if tier not in _ALLOWED_MODELS:
            raise ValueError(f"model must be one of {sorted(_ALLOWED_MODELS)}")
        return tier

    @field_validator("telemetry")
    @classmethod
    def bounded_telemetry(cls, value: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        return _bounded_flat_map(value, limit=MAX_TELEMETRY_KEYS, label="telemetry")

    @field_validator("personalization")
    @classmethod
    def bounded_personalization(cls, value: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        return _bounded_flat_map(value, limit=MAX_PERSONALIZATION_KEYS, label="personalization")


@router.post("/api/chat/stream", operation_id="chatStream")
async def chat_stream(
    payload: ChatStreamPayload,
    request: Request,
    authorization: Optional[str] = Header(None),
) -> StreamingResponse:
    session = verify_auth_header(authorization)
    anonymous = not session.has_account_storage
    peer = peer_network_id(request) if anonymous else ""
    request_id = request.headers.get("x-request-id") or f"req_{uuid.uuid4().hex[:12]}"
    model = payload.model or "standard"
    history = [{"role": turn.role, "content": turn.body()} for turn in payload.history]
    client_context = payload.client_context.model_dump(exclude_none=True) if payload.client_context else None
    preflight = orchestrator.preflight_turn(
        user_id_hash=session.user_id_hash,
        message=payload.message,
        history=history,
        model=model,
        anonymous=anonymous,
        peer=peer,
    )
    if preflight.error:
        raise preflight.error

    async def sse_generator():
        try:
            async with aclosing(
                orchestrator.execute_turn_stream(
                    user_id_hash=session.user_id_hash,
                    message=payload.message,
                    history=history,
                    session_id=payload.session_id,
                    model=model,
                    telemetry=payload.telemetry,
                    personalization=payload.personalization,
                    client_context=client_context,
                    request_id=request_id,
                    preflight=preflight,
                    consume_quota=False,
                    anonymous=anonymous,
                    peer=peer,
                )
            ) as events:
                async for chunk in events:
                    if await request.is_disconnected():
                        logger.info("chat_stream_disconnected request_id=%s", request_id)
                        return
                    yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                    if chunk.get("error"):
                        return
            yield "data: [DONE]\n\n"
        except asyncio.CancelledError:
            logger.info("chat_stream_cancelled request_id=%s", request_id)
            raise

    return StreamingResponse(
        sse_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Request-Id": request_id, "X-Accel-Buffering": "no"},
    )
