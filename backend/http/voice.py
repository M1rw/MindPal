# backend/http/voice.py — Thin HTTP adapter for Voice tokens

from __future__ import annotations

from typing import Dict, Any, Optional
from fastapi import APIRouter, Header

from backend.domain.identity.identity import verify_auth_header
from backend.domain.voice.token import VoiceTokenService

router = APIRouter()
voice_service = VoiceTokenService()


@router.post("/api/voice/session-token", operation_id="voiceCreateSessionToken")
def create_voice_session_token(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    session = verify_auth_header(authorization)
    return voice_service.create_voice_token(session.user_id_hash)
