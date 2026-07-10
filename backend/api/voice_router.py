# backend/api/voice_router.py

"""
Voice transcription and call summarization endpoints.

Security:
- API keys are NEVER exposed to the client (no /key endpoint)
- API keys sent via headers, never in URL query strings
- Authentication required on all endpoints that consume LLM quota
- Error messages are sanitized (no raw exception text)

Business logic lives in backend/tools/voice_tools.py.
This router is a thin HTTP wrapper.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.api.dependencies import RequestContextDep, ServicesDep
from backend.core.config import get_settings
from backend.core.security import sanitize_text
from backend.tools import ToolContext
from backend.tools.voice_tools import VoiceSummarizeTool, VoiceTranscribeTool


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/voice", tags=["voice"])

MAX_AUDIO_BASE64_CHARS = 15_000_000  # ~10MB of audio after base64 encoding
MAX_TRANSCRIPT_CHARS = 4_000
MAX_MIME_TYPE_CHARS = 80

# Lazy singleton tool instances
_summarize_tool = VoiceSummarizeTool()
_transcribe_tool = VoiceTranscribeTool()


class TranscribeRequest(BaseModel):
    """Audio transcription request. Requires authentication."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    audio_base64: str = Field(
        min_length=1,
        max_length=MAX_AUDIO_BASE64_CHARS,
        description="Base64-encoded audio data",
    )
    mime_type: str = Field(
        default="audio/webm",
        max_length=MAX_MIME_TYPE_CHARS,
    )

    @field_validator("mime_type", mode="before")
    @classmethod
    def _clean_mime_type(cls, value: object) -> str:
        raw = sanitize_text(str(value or "audio/webm"), MAX_MIME_TYPE_CHARS)
        # Strip codec parameters: "audio/webm;codecs=opus" → "audio/webm"
        return raw.split(";")[0].strip() or "audio/webm"


class TranscribeResponse(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    text: str
    request_id: str | None = None


class SummarizeRequest(BaseModel):
    """Voice call summarization request. Requires authentication."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    user_transcript: str = Field(default="", max_length=MAX_TRANSCRIPT_CHARS)
    ai_transcript: str = Field(default="", max_length=MAX_TRANSCRIPT_CHARS)

    @field_validator("user_transcript", "ai_transcript", mode="before")
    @classmethod
    def _clean_transcript(cls, value: object) -> str:
        return sanitize_text(str(value or ""), MAX_TRANSCRIPT_CHARS)


class VoiceTokenResponse(BaseModel):
    """Short-lived credentials for one Gemini Live API session."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    token: str = Field(min_length=1, max_length=8_000)
    model: str = Field(min_length=1, max_length=120)
    websocket_url: str = Field(min_length=1, max_length=500)
    expires_at: str
    new_session_expires_at: str


@router.post("/transcribe", response_model=TranscribeResponse)
async def transcribe_audio(
    payload: TranscribeRequest,
    services: ServicesDep,
    context: RequestContextDep,
) -> TranscribeResponse:
    """
    Transcribe audio using Gemini multimodal API.

    Security:
    - Requires authentication (consumes LLM quota)
    - API key sent via x-goog-api-key header, never in URL
    - Error messages are sanitized
    """
    _require_authenticated(context)

    tool_context = ToolContext(
        user_id_hash=context.session.user_id_hash,
        authenticated=context.session.authenticated,
        locale=context.locale,
        request_id=context.request_id,
        services=services,
    )

    result = await _transcribe_tool.execute(
        {"audio_base64": payload.audio_base64, "mime_type": payload.mime_type},
        tool_context,
    )

    if not result.ok:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={
                "code": "transcription_failed",
                "message": result.error or "Audio transcription failed. Please try again.",
                "request_id": context.request_id,
            },
        )

    return TranscribeResponse(
        text=result.data.get("text", ""),
        request_id=context.request_id,
    )


@router.post("/summarize")
async def summarize_call(
    payload: SummarizeRequest,
    services: ServicesDep,
    context: RequestContextDep,
) -> dict[str, Any]:
    """
    Summarize a voice call transcript.

    Requires authentication (consumes LLM quota).
    """
    _require_authenticated(context)

    tool_context = ToolContext(
        user_id_hash=context.session.user_id_hash,
        authenticated=context.session.authenticated,
        locale=context.locale,
        request_id=context.request_id,
        services=services,
    )

    result = await _summarize_tool.execute(
        {"user_transcript": payload.user_transcript, "ai_transcript": payload.ai_transcript},
        tool_context,
    )

    return {
        "summary": result.data.get("summary", "Voice call"),
        "request_id": context.request_id,
    }


# ═══════════════════════════════════════════════════════════════
# Internal helpers
# ═══════════════════════════════════════════════════════════════

def _get_gemini_key(settings: Any) -> str:
    """Safely extract the Gemini API key from settings."""
    value = getattr(settings, "GEMINI_API_KEY", None)
    if hasattr(value, "get_secret_value"):
        return value.get_secret_value() or ""
    return str(value or "").strip()


@router.get("/token", response_model=VoiceTokenResponse)
async def get_voice_token(
    response: Response,
    context: RequestContextDep,
) -> VoiceTokenResponse:
    """Issue one short-lived Gemini Live API token without exposing the API key."""
    _require_authenticated(context)

    settings = get_settings()
    api_key = _get_gemini_key(settings)
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "gemini_not_configured",
                "message": "Voice service is not available",
                "request_id": context.request_id,
            },
        )

    now = dt.datetime.now(tz=dt.timezone.utc)
    expires_at = now + dt.timedelta(seconds=int(settings.VOICE_TOKEN_TTL_SECONDS))
    new_session_expires_at = now + dt.timedelta(seconds=int(settings.VOICE_NEW_SESSION_TTL_SECONDS))

    try:
        token_name = await _create_ephemeral_voice_token(
            api_key=api_key,
            model=settings.GEMINI_LIVE_MODEL,
            expires_at=expires_at,
            new_session_expires_at=new_session_expires_at,
        )
    except ModuleNotFoundError as exc:
        logger.error("google-genai is not installed; voice token provisioning is unavailable")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "voice_dependency_missing",
                "message": "Voice service is temporarily unavailable",
                "request_id": context.request_id,
            },
        ) from exc
    except Exception as exc:
        logger.exception("Failed to provision Gemini Live ephemeral token")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={
                "code": "voice_token_provision_failed",
                "message": "Could not start a secure voice session",
                "request_id": context.request_id,
            },
        ) from exc

    response.headers["Cache-Control"] = "no-store, private"
    response.headers["Pragma"] = "no-cache"
    return VoiceTokenResponse(
        token=token_name,
        model=settings.GEMINI_LIVE_MODEL,
        websocket_url=(
            "wss://generativelanguage.googleapis.com/ws/"
            "google.ai.generativelanguage.v1alpha.GenerativeService."
            "BidiGenerateContentConstrained"
        ),
        expires_at=expires_at.isoformat().replace("+00:00", "Z"),
        new_session_expires_at=new_session_expires_at.isoformat().replace("+00:00", "Z"),
    )


@router.get("/key", status_code=status.HTTP_410_GONE)
async def retired_voice_key_endpoint(context: RequestContextDep) -> None:
    """Permanent provider keys are intentionally never returned to browsers."""
    _require_authenticated(context)
    raise HTTPException(
        status_code=status.HTTP_410_GONE,
        detail={
            "code": "voice_key_endpoint_retired",
            "message": "Use the secure voice token endpoint",
            "request_id": context.request_id,
        },
    )


async def _create_ephemeral_voice_token(
    *,
    api_key: str,
    model: str,
    expires_at: dt.datetime,
    new_session_expires_at: dt.datetime,
) -> str:
    """Create a constrained token in a worker thread because the SDK call is synchronous."""

    def create() -> str:
        from google import genai

        client = genai.Client(
            api_key=api_key,
            http_options={"api_version": "v1alpha"},
        )
        try:
            token = client.auth_tokens.create(
                config={
                    "uses": 1,
                    "expire_time": expires_at,
                    "new_session_expire_time": new_session_expires_at,
                    "live_connect_constraints": {
                        "model": model,
                        "config": {
                            "session_resumption": {},
                            "response_modalities": ["AUDIO"],
                        },
                    },
                    "http_options": {"api_version": "v1alpha"},
                }
            )
            name = str(getattr(token, "name", "") or "").strip()
            if not name:
                raise RuntimeError("Gemini returned an empty ephemeral token")
            return name
        finally:
            client.close()

    return await asyncio.to_thread(create)


def _require_authenticated(context: Any) -> None:
    """Require authenticated session for voice endpoints."""
    session = getattr(context, "session", None)
    if session is None or not getattr(session, "authenticated", False):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "authentication_required",
                "message": "Authentication is required for voice operations",
                "request_id": getattr(context, "request_id", None),
            },
        )
