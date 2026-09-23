# backend/http/voice.py — Thin HTTP adapter for Gemini Live mint and control events

from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Header

from backend.core.errors import AppError
from backend.domain.identity.identity import verify_auth_header
from backend.domain.voice.contracts.requests import (
    VoiceDiagnosticsRequest,
    VoiceReactionRequest,
    VoiceRecallRequest,
    VoiceSessionEventRequest,
    VoiceSummarizeRequest,
    VoiceTokenRequest,
)
from backend.tools.voice_diagnostics import persist_voice_diagnostics
from backend.domain.voice.contracts.responses import VoiceRecallResponse, VoiceReactionResponse, VoiceSessionActionResponse, VoiceSummaryResponse, VoiceTokenResponse
from backend.domain.voice.services.reaction import VoiceReactionService
from backend.domain.voice.services.recall import VoiceRecallService
from backend.domain.voice.services.session import VoiceSessionService
from backend.domain.voice.services.summarize import VoiceSummarizeService

router = APIRouter()
session_service = VoiceSessionService()
summarize_service = VoiceSummarizeService(session_service=session_service)
reaction_service = VoiceReactionService()
recall_service = VoiceRecallService(store=session_service.store)


@router.post("/api/voice/reaction", operation_id="voiceClassifyReaction", response_model=VoiceReactionResponse)
def classify_voice_reaction(
    payload: VoiceReactionRequest,
    authorization: Optional[str] = Header(None),
) -> Dict[str, Any]:
    """The face's listening reaction to a phrase, in any language. Never speaks."""
    session = verify_auth_header(authorization)
    if not session.is_authenticated:
        raise AppError(
            "unauthenticated",
            "Live voice requires a signed-in account.",
        )
    evaluation = session_service.flags.evaluate("voice.realtime", session.user_id_hash)
    if not evaluation.enabled:
        raise AppError(
            "forbidden",
            "Live voice is not enabled for this account. Composer dictation is still available.",
        )
    reaction = reaction_service.classify(
        user_id_hash=session.user_id_hash,
        text=payload.text,
        context=payload.context,
        speaker=payload.speaker,
    )
    return {"reaction": reaction}


@router.post("/api/voice/recall", operation_id="voiceRecall", response_model=VoiceRecallResponse)
def recall_for_voice(
    payload: VoiceRecallRequest,
    authorization: Optional[str] = Header(None),
) -> Dict[str, Any]:
    """The live model's memory and past-chat lookups, for the caller's own call only."""
    session = verify_auth_header(authorization)
    if not session.is_authenticated:
        raise AppError(
            "unauthenticated",
            "Live voice requires a signed-in account.",
        )
    evaluation = session_service.flags.evaluate("voice.realtime", session.user_id_hash)
    if not evaluation.enabled:
        raise AppError(
            "forbidden",
            "Live voice is not enabled for this account. Composer dictation is still available.",
        )
    return recall_service.recall(
        user_id_hash=session.user_id_hash,
        session_id=payload.session_id,
        tool=payload.tool,
        query=payload.query,
    ).as_dict()


@router.post("/api/voice/session-token", operation_id="voiceCreateSessionToken", response_model=VoiceTokenResponse)
def create_voice_session_token(
    payload: VoiceTokenRequest,
    authorization: Optional[str] = Header(None),
) -> Dict[str, Any]:
    session = verify_auth_header(authorization)
    return session_service.mint(
        user_id_hash=session.user_id_hash,
        is_authenticated=session.is_authenticated,
        consent_attested=payload.consent_attested,
        voice_id=payload.voice_id,
        voice_language=payload.voice_language,
        personalization=payload.personalization,
    )


@router.post("/api/voice/session-events", operation_id="voiceRecordSessionEvent", response_model=VoiceSessionActionResponse)
def record_voice_session_event(
    payload: VoiceSessionEventRequest,
    authorization: Optional[str] = Header(None),
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
) -> Dict[str, Any]:
    session = verify_auth_header(authorization)
    if not session.is_authenticated:
        raise AppError(
            "unauthenticated",
            "Live voice requires a signed-in account.",
        )
    return session_service.handle_event(
        user_id_hash=session.user_id_hash,
        payload=payload.model_dump(),
        idempotency_key=(idempotency_key or "").strip()[:128],
    )


@router.post("/api/voice/trace", operation_id="voiceSubmitTrace")
def submit_voice_trace(
    payload: VoiceDiagnosticsRequest,
    authorization: Optional[str] = Header(None),
) -> Dict[str, Any]:
    session = verify_auth_header(authorization)
    if not session.is_authenticated:
        raise AppError("unauthenticated", "Voice trace upload requires a signed-in account.")
    record = session_service.store.get_document("voice_sessions", payload.session_id)
    if not record or record.get("user_id_hash") != session.user_id_hash:
        raise AppError("not_found", "That live voice session is not available.")
    return persist_voice_diagnostics(payload.session_id, payload.trace, user_id_hash=session.user_id_hash)


@router.post("/api/voice/summarize", operation_id="voiceSummarizeSession", response_model=VoiceSummaryResponse)
async def summarize_voice_session(
    payload: VoiceSummarizeRequest,
    authorization: Optional[str] = Header(None),
) -> Dict[str, Any]:
    session = verify_auth_header(authorization)
    if not session.is_authenticated:
        raise AppError(
            "unauthenticated",
            "Live voice requires a signed-in account.",
        )
    return await summarize_service.summarize(
        user_id_hash=session.user_id_hash,
        session_id=payload.session_id,
        chat_session_id=payload.chat_session_id or "",
        user_transcript=payload.user_transcript,
        ai_transcript=payload.ai_transcript,
    )
