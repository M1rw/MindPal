# backend/http/dictation.py — Thin HTTP adapter for composer dictation

from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Header, Request
from starlette.concurrency import run_in_threadpool

from backend.core.errors import AppError
from backend.domain.dictation.service import MAX_AUDIO_BYTES, DictationService
from backend.domain.identity.identity import verify_auth_header
from backend.domain.quota.quota import peer_network_id

router = APIRouter()
service = DictationService()


@router.post("/api/transcribe", operation_id="dictationTranscribe")
async def transcribe(
    request: Request,
    authorization: Optional[str] = Header(None),
    content_type: str = Header("", alias="Content-Type"),
) -> Dict[str, Any]:
    """The raw voice note is the request body (audio/webm, audio/mp4, ...); no multipart."""
    session = await run_in_threadpool(verify_auth_header, authorization)
    declared = int(request.headers.get("content-length") or 0)
    if declared > MAX_AUDIO_BYTES:
        raise AppError("payload_invalid", "That recording is too long to transcribe. Try a shorter one.")
    audio = await request.body()
    signed_in = session.has_account_storage
    subject = session.user_id_hash if signed_in else f"peer:{peer_network_id(request)}"
    result = await run_in_threadpool(
        service.transcribe, audio, content_type, subject=subject, signed_in=signed_in
    )
    return {"text": result.text, "language": result.language}
