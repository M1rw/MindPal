# backend/http/voice.py — Thin HTTP adapter for Gemini Live mint and control events

from __future__ import annotations

from typing import Any, Dict, Literal, Optional

from fastapi import APIRouter, Header
from pydantic import BaseModel, Field

from backend.core.errors import AppError
from backend.domain.identity.identity import verify_auth_header
from backend.domain.voice.reaction import VoiceReactionService
from backend.domain.voice.recall import VoiceRecallService
from backend.domain.voice.session import VoiceSessionService
from backend.domain.voice.summarize import VoiceSummarizeService

router = APIRouter()
session_service = VoiceSessionService()
summarize_service = VoiceSummarizeService(session_service=session_service)
reaction_service = VoiceReactionService()
recall_service = VoiceRecallService(store=session_service.store)


class VoiceTokenRequest(BaseModel):
    consent_attested: bool = False
    voice_id: Optional[str] = None
    voice_language: Optional[str] = None
    personalization: Optional[Dict[str, Any]] = None


class VoiceReactionRequest(BaseModel):
    text: str = Field(default="", max_length=2000)
    context: str = Field(default="", max_length=2000)
    # "caller": the listening face's reaction. "mindpal": the face matching its own speech.
    speaker: Literal["caller", "mindpal"] = "caller"


@router.post("/api/voice/reaction", operation_id="voiceClassifyReaction")
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


class VoiceRecallRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=64)
    tool: Literal["search_memory", "search_past_chats"]
    query: str = Field(default="", max_length=2000)


@router.post("/api/voice/recall", operation_id="voiceRecall")
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


class VoiceSessionEventRequest(BaseModel):
    # Empty session_id is allowed only for voice.session.teardown so a client that
    # lost the grant can hang up the account's one active call.
    session_id: Optional[str] = None
    event: str
    to: Optional[str] = None
    reason: Optional[str] = None
    text: Optional[str] = None
    is_final: bool = False
    # Cumulative buffers for voice.transcript.sync. A disclosure split across ASR
    # deltas only matches when the whole utterance is classified together.
    input_text: Optional[str] = None
    output_text: Optional[str] = None
    input_ledger: Optional[str] = None
    output_ledger: Optional[str] = None
    source: Optional[str] = None
    t_setup_ms: Optional[int] = None
    used_s: Optional[int] = Field(default=None, ge=0)
    played_ms: Optional[int] = Field(default=None, ge=0)
    resumption_handle: Optional[str] = None
    # voice.safety.risk_rating: the Live model's own in-band rating of the caller.
    risk: Optional[float] = Field(default=None, ge=0, le=10)
    danger_kind: Optional[str] = None
    band: Optional[str] = None
    confirmations: Optional[int] = Field(default=None, ge=0)


@router.get("/api/voice/usage", operation_id="voiceGetUsage")
def get_voice_usage(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    """Today's live-voice budget. Read-only: it never reserves or mutates."""
    session = verify_auth_header(authorization)
    if not session.is_authenticated:
        raise AppError("unauthenticated", "Live voice usage requires a signed-in account.")
    return session_service.usage_snapshot(user_id_hash=session.user_id_hash)


@router.post("/api/voice/session-token", operation_id="voiceCreateSessionToken")
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


@router.post("/api/voice/session-events", operation_id="voiceRecordSessionEvent")
def record_voice_session_event(
    payload: VoiceSessionEventRequest,
    authorization: Optional[str] = Header(None),
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
    )


class VoiceSummarizeRequest(BaseModel):
    session_id: str
    chat_session_id: Optional[str] = None
    user_transcript: str = ""
    ai_transcript: str = ""


@router.post("/api/voice/summarize", operation_id="voiceSummarizeSession")
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
