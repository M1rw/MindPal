# backend/http/chat.py — Thin HTTP adapter for streaming chat

from __future__ import annotations

from typing import Optional
from fastapi import APIRouter, Header
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from backend.domain.chat.orchestrator import ChatOrchestrator
from backend.domain.identity.identity import verify_auth_header

router = APIRouter()
orchestrator = ChatOrchestrator()


class ChatStreamPayload(BaseModel):
    message: str
    session_id: Optional[str] = None


@router.post("/api/chat/stream", operation_id="chatStream")
async def chat_stream(payload: ChatStreamPayload, authorization: Optional[str] = Header(None)) -> StreamingResponse:
    session = verify_auth_header(authorization)

    async def sse_generator():
        async for token in orchestrator.execute_turn_stream(
            user_id_hash=session.user_id_hash,
            message=payload.message,
            session_id=payload.session_id,
        ):
            yield f"data: {token}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(sse_generator(), media_type="text/event-stream")
