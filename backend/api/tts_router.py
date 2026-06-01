# backend/api/tts_router.py

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.api.dependencies import RequestContextDep, ServicesDep
from backend.core.errors import AppError
from backend.core.security import normalize_locale, sanitize_text
from backend.models.schemas import TTSFormat, TTSRequest, TTSResponse


router = APIRouter(prefix="/api/tts", tags=["tts"])

MAX_RESPONSE_MODE_CHARS = 80
MAX_SAFETY_LEVEL_CHARS = 80
MAX_TEXT_CHARS = 4_000
MAX_VOICE_ID_CHARS = 120


class TTSSynthesizePayload(BaseModel):
    """
    Public TTS synthesis payload.

    External TTS is automatically disabled by service policy for crisis/high-risk
    safety levels. The client cannot override that from this public endpoint.
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    text: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)
    locale: str = Field(default="auto", max_length=40)
    response_mode: str = Field(default="normal_support", max_length=MAX_RESPONSE_MODE_CHARS)
    safety_level: str = Field(default="safe", max_length=MAX_SAFETY_LEVEL_CHARS)
    voice_id: str | None = Field(default=None, max_length=MAX_VOICE_ID_CHARS)
    format: TTSFormat = TTSFormat.MP3
    speaking_rate: float | None = Field(default=None, ge=0.5, le=2.0)

    @field_validator("text", mode="before")
    @classmethod
    def _clean_text(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), MAX_TEXT_CHARS)
        if not cleaned:
            raise ValueError("TTS text cannot be empty")
        return cleaned

    @field_validator("locale", mode="before")
    @classmethod
    def _clean_locale(cls, value: object) -> str:
        return normalize_locale(str(value or "auto"))

    @field_validator("response_mode", "safety_level", "voice_id", mode="before")
    @classmethod
    def _clean_optional_text(cls, value: object) -> object:
        if value is None:
            return None

        cleaned = sanitize_text(str(value), MAX_VOICE_ID_CHARS)
        return cleaned or None


class TTSPolicyResponse(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    request_id: str
    locale: str
    voice_id: str | None
    speaking_rate: float
    format: TTSFormat
    browser_fallback_allowed: bool
    external_tts_allowed: bool
    reason: str


@router.post("/synthesize", response_model=TTSResponse)
async def synthesize_tts(
    payload: TTSSynthesizePayload,
    services: ServicesDep,
    context: RequestContextDep,
) -> TTSResponse:
    """
    Synthesize assistant text.

    Public route safety:
    - text is sanitized before provider calls
    - external TTS is disabled by default for crisis/high-risk safety levels
    - browser fallback is always allowed when available
    - no raw provider credentials or internal payloads are exposed
    """
    try:
        return await services.tts.synthesize_text(
            text=payload.text,
            locale=payload.locale if payload.locale != "auto" else context.locale,
            response_mode=payload.response_mode,
            safety_level=payload.safety_level,
            voice_id=payload.voice_id,
            format=payload.format,
            speaking_rate=payload.speaking_rate,
            allow_external_for_crisis=False,
        )

    except AppError as exc:
        raise _http_error_from_app_error(exc) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "tts_synthesis_failed",
                "message": "Failed to synthesize speech",
                "request_id": context.request_id,
            },
        ) from exc


@router.post("/policy", response_model=TTSPolicyResponse)
async def tts_policy(
    payload: TTSSynthesizePayload,
    services: ServicesDep,
    context: RequestContextDep,
) -> TTSPolicyResponse:
    """
    Return the TTS policy that would be used for the given request.

    Does not call external TTS providers.
    """
    try:
        policy = services.tts.select_policy(
            locale=payload.locale if payload.locale != "auto" else context.locale,
            response_mode=payload.response_mode,
            safety_level=payload.safety_level,
            voice_id=payload.voice_id,
            format=payload.format,
            speaking_rate=payload.speaking_rate,
            allow_external_for_crisis=False,
        )

        return TTSPolicyResponse(
            request_id=context.request_id,
            locale=policy.locale,
            voice_id=policy.voice_id,
            speaking_rate=policy.speaking_rate,
            format=policy.format,
            browser_fallback_allowed=policy.browser_fallback_allowed,
            external_tts_allowed=policy.external_tts_allowed,
            reason=policy.reason,
        )

    except AppError as exc:
        raise _http_error_from_app_error(exc) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "tts_policy_failed",
                "message": "Failed to select TTS policy",
                "request_id": context.request_id,
            },
        ) from exc


@router.get("/health")
async def tts_health(
    services: ServicesDep,
    context: RequestContextDep,
) -> dict[str, Any]:
    """
    TTS subsystem health.

    Does not expose provider credentials or raw synthesis payloads.
    """
    return {
        "request_id": context.request_id,
        "tts": services.tts.health(),
    }


def _http_error_from_app_error(exc: AppError) -> HTTPException:
    status_code = getattr(exc, "status_code", None) or status.HTTP_500_INTERNAL_SERVER_ERROR
    code = getattr(exc, "code", None) or exc.__class__.__name__
    message = sanitize_text(str(exc), 500) or "Application error"
    details = getattr(exc, "details", None) or {}

    return HTTPException(
        status_code=status_code,
        detail={
            "code": code,
            "message": message,
            "details": details,
        },
    )