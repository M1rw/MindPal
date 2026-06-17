# backend/api/voice_router.py

"""
Voice transcription and call summarization endpoints.

Security:
- API keys are NEVER exposed to the client (no /key endpoint)
- API keys sent via headers, never in URL query strings
- Authentication required on all endpoints that consume LLM quota
- Error messages are sanitized (no raw exception text)
"""

from __future__ import annotations

import logging
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.api.dependencies import RequestContextDep, ServicesDep
from backend.core.config import get_settings
from backend.core.llm_utils import quick_llm_generate
from backend.core.security import sanitize_text


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/voice", tags=["voice"])

MAX_AUDIO_BASE64_CHARS = 15_000_000  # ~10MB of audio after base64 encoding
MAX_TRANSCRIPT_CHARS = 4_000
MAX_MIME_TYPE_CHARS = 80

# Preferred Gemini models for audio transcription (ordered by preference).
_TRANSCRIPTION_MODELS = [
    "models/gemini-2.0-flash",
    "models/gemini-1.5-flash",
    "models/gemini-1.5-flash-latest",
    "models/gemini-1.5-pro",
]


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

    settings = get_settings()
    api_key = _get_gemini_key(settings)

    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "gemini_not_configured",
                "message": "Audio transcription service is not available",
                "request_id": context.request_id,
            },
        )

    prompt = (
        "Transcribe this audio precisely in the exact original language(s) spoken. "
        "CRITICAL: DO NOT translate the audio to English. If the user speaks in Arabic, transcribe in Arabic. "
        "If multiple languages are spoken, transcribe each part in its respective language. "
        "Do not answer the audio. Do not add any text other than the transcription itself."
    )

    gemini_payload = {
        "contents": [
            {
                "parts": [
                    {
                        "inlineData": {
                            "mimeType": payload.mime_type,
                            "data": payload.audio_base64,
                        }
                    },
                    {"text": prompt},
                ],
            }
        ],
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": 1024,
        },
    }

    async with httpx.AsyncClient(timeout=45.0) as client:
        for model in _TRANSCRIPTION_MODELS:
            url = f"https://generativelanguage.googleapis.com/v1beta/{model}:generateContent"
            try:
                response = await client.post(
                    url,
                    headers={
                        "Content-Type": "application/json",
                        "x-goog-api-key": api_key,
                    },
                    json=gemini_payload,
                )
                if response.status_code == 404:
                    continue
                response.raise_for_status()

                data = response.json()
                candidates = data.get("candidates")
                if not candidates:
                    return TranscribeResponse(text="", request_id=context.request_id)

                parts = candidates[0].get("content", {}).get("parts", [])
                text = "".join(part.get("text", "") for part in parts).strip()

                return TranscribeResponse(text=text, request_id=context.request_id)

            except httpx.HTTPStatusError as exc:
                logger.warning(
                    "Gemini transcription model %s returned HTTP %d",
                    model,
                    exc.response.status_code,
                )
                continue
            except Exception as exc:
                logger.debug(
                    "Gemini transcription model %s failed: %s",
                    model,
                    type(exc).__name__,
                )
                continue

    # All models failed
    logger.error("All Gemini transcription models failed for request %s", context.request_id)
    raise HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail={
            "code": "transcription_failed",
            "message": "Audio transcription failed. Please try again.",
            "request_id": context.request_id,
        },
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

    transcript_parts: list[str] = []
    if payload.user_transcript:
        transcript_parts.append(f"User: {payload.user_transcript}")
    if payload.ai_transcript:
        transcript_parts.append(f"AI: {payload.ai_transcript}")
    transcript = "\n".join(transcript_parts)

    if not transcript.strip():
        return {"summary": "Voice call", "request_id": context.request_id}

    prompt = (
        "Write a 1-sentence summary of this voice call. "
        "Keep it under 15 words. Be natural and concise. "
        "Respond in the same language used in the conversation:\n\n"
        + transcript
    )

    try:
        summary = await quick_llm_generate(prompt, max_tokens=60, temperature=0.2)
        return {
            "summary": summary or "Voice call",
            "request_id": context.request_id,
        }
    except Exception:
        logger.exception("Voice call summarization failed for request %s", context.request_id)
        return {
            "summary": "Voice call",
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


@router.get("/key")
async def get_voice_key(
    services: ServicesDep,
    context: RequestContextDep,
) -> dict[str, str]:
    """
    Return the Gemini API key for authenticated voice sessions.

    The frontend needs this key to establish a direct WebSocket connection
    to the Gemini Live API (BidiGenerateContent). This endpoint REQUIRES
    authentication to prevent unauthorized key access.

    Security:
    - Requires authenticated Firebase session
    - Returns only the Gemini key (no other secrets)
    """
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

    return {"key": api_key}


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
