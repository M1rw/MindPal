# backend/http/chat.py — Thin HTTP adapter for streaming chat

from __future__ import annotations

import asyncio
import functools
import json
import logging
import uuid
from contextlib import aclosing
from typing import Optional

from fastapi import APIRouter, Header, Request
from starlette.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask
from backend.domain.chat.contracts import ChatStreamPayload
from backend.domain.chat.orchestrator import ChatOrchestrator
from backend.domain.dynamic.policy import current_load
from backend.domain.identity.identity import verify_auth_header
from backend.domain.quota.quota import peer_network_id
from backend.core.request_context import request_id as current_request_id
from backend.domain.files.turn import EMPTY_MESSAGE, TurnFiles, library_turn_files, resolve_turn_files

router = APIRouter()
orchestrator = ChatOrchestrator()
logger = logging.getLogger("mindpal.chat")

# Everything below is attacker-controlled. Without ceilings, one request can pin
# a worker on regex scanning, blow past the provider's context window, and bill
# a full turn's tokens for a single credit.
@router.post("/api/chat/stream", operation_id="chatStream")
async def chat_stream(
    payload: ChatStreamPayload,
    request: Request,
    authorization: Optional[str] = Header(None),
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
) -> StreamingResponse:
    # Token verification, the safety check and the quota reservation all do
    # blocking network I/O (Firebase, the store). Run on the event loop they
    # stalled every other stream on this worker while they waited (audit MP-09).
    session = await run_in_threadpool(verify_auth_header, authorization)
    anonymous = not session.has_account_storage
    peer = peer_network_id(request) if anonymous else ""
    if anonymous and peer:
        from backend.domain.identity.identity import _note_activity

        await run_in_threadpool(_note_activity, f"peer:{peer}")
    request_id = current_request_id() or f"req_{uuid.uuid4().hex[:12]}"
    model = payload.model or "standard"
    history = [{"role": turn.role, "content": turn.body()} for turn in payload.history]
    files = TurnFiles()
    if payload.attachments:
        files = await run_in_threadpool(
            functools.partial(
                resolve_turn_files,
                payload.attachments,
                user_id_hash=session.user_id_hash,
                signed_in=session.has_account_storage,
            )
        )
    elif session.has_account_storage and payload.message:
        # "What did my lease say about pets?": their library file, found for them.
        files = await run_in_threadpool(library_turn_files, payload.message, user_id_hash=session.user_id_hash)
    message = payload.message or EMPTY_MESSAGE
    client_context = payload.client_context.model_dump(exclude_none=True) if payload.client_context else None
    preflight = await run_in_threadpool(
        orchestrator.preflight_turn,
        user_id_hash=session.user_id_hash,
        message=message,
        history=history,
        model=model,
        anonymous=anonymous,
        peer=peer,
        idempotency_key=(idempotency_key or "").strip()[:128],
        files_text=files.safety_text(),
    )
    if preflight.error:
        raise preflight.error

    async def sse_generator():
        try:
            async with aclosing(
                orchestrator.execute_turn_stream(
                    user_id_hash=session.user_id_hash,
                    message=message,
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
                    files=files or None,
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
        # Runs after the reply has fully streamed, never before or during it.
        background=None if anonymous else BackgroundTask(consolidate_if_due, session.user_id_hash),
    )


def consolidate_if_due(user_id_hash: str) -> None:
    """Inline memory consolidation when this person has queued work and load allows.

    Under busy-enough load the policy turns inline work off and the scheduler
    picks the job up later instead.
    """
    try:
        consolidation = orchestrator.consolidation
        if not consolidation.has_pending(user_id_hash):
            return
        if not current_load().policy("memory")["opportunistic"]:
            return
        consolidation.run(user_id_hash)
    except Exception as exc:
        logger.warning("memory_consolidation_inline_skipped error=%s", type(exc).__name__)
