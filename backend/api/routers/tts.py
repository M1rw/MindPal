# backend/api/tts_router.py

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.api.dependencies import (
    AuthenticatedRequestContextDep,
    RequestContextDep,
    ServicesDep,
    assert_authenticated,
    http_error_from_app_error,
)
from backend.core.errors import AppError
from backend.core.security import normalize_locale, sanitize_text
from backend.models.schemas import TTSFormat, TTSResponse


router = APIRouter(prefix="/api/tts", tags=["tts"])

MAX_RESPONSE_MODE_CHARS = 80
MAX_SAFETY_LEVEL_CHARS = 80
MAX_TEXT_CHARS = 4_000
MAX_VOICE_ID_CHARS = 120


class TTSSynthesizePayload(BaseModel):
    """
    TTS synthesis payload.

    Backend synthesis requires authentication because external TTS providers can
    consume paid quota. Guest users should use frontend/browser TTS directly.

    External TTS is automatically disabled by service policy for crisis/high-risk
    safety levels. The client cannot override that from this endpoint.
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

    @field_validator("response_mode", mode="before")
    @classmethod
    def _clean_response_mode(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or "normal_support"), MAX_RESPONSE_MODE_CHARS)
        return cleaned or "normal_support"

    @field_validator("safety_level", mode="before")
    @classmethod
    def _clean_safety_level(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or "safe"), MAX_SAFETY_LEVEL_CHARS)
        return cleaned or "safe"

    @field_validator("voice_id", mode="before")
    @classmethod
    def _clean_voice_id(cls, value: object) -> object:
        if value is None:
            return None

        cleaned = sanitize_text(str(value), MAX_VOICE_ID_CHARS)
        return cleaned or None


class TTSPolicyResponse(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    request_id: str
    authenticated: bool
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
    context: AuthenticatedRequestContextDep,
) -> TTSResponse:
    assert_authenticated(context)
    operation_id = sanitize_text(f"{context.request_id}:tts", 120)
    claim = None
    reserved = False
    try:
        await services.rate_limits.consume(
            scope="tts",
            subject=context.session.user_id_hash,
            limit=services.settings.TTS_RATE_LIMIT_PER_MINUTE,
            window_seconds=60,
        )
        claim = await services.idempotency.claim(
            user_id_hash=context.session.user_id_hash,
            key=context.request_id,
            operation="tts_synthesize",
            payload_hash=services.idempotency.payload_hash(payload.model_dump(mode="json")),
        )
        if claim.completed:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "idempotent_result_not_replayable",
                    "message": "This synthesis request already completed; use its original response",
                    "request_id": context.request_id,
                },
            )
        await services.quota.reserve(
            user_id_hash=context.session.user_id_hash,
            request_id=operation_id,
            cost=services.settings.PROVIDER_OPERATION_QUOTA_COST,
            operation="tts_synthesize",
        )
        reserved = True
        result = await services.tts.synthesize_text(
            text=payload.text,
            locale=payload.locale if payload.locale != "auto" else context.locale,
            response_mode=payload.response_mode,
            safety_level=payload.safety_level,
            voice_id=payload.voice_id,
            format=payload.format,
            speaking_rate=payload.speaking_rate,
            allow_external_for_crisis=False,
        )
        # Browser fallback does not consume an external provider, so return the
        # reservation instead of charging the account.
        if result.fallback_to_browser:
            await services.quota.refund(user_id_hash=context.session.user_id_hash, request_id=operation_id)
        else:
            await services.quota.commit(user_id_hash=context.session.user_id_hash, request_id=operation_id)
        await services.idempotency.complete(claim=claim, response={"completed": True})
        return result.model_copy(update={"request_id": context.request_id})
    except AppError as exc:
        if reserved:
            await services.quota.refund(user_id_hash=context.session.user_id_hash, request_id=operation_id)
        if claim:
            await services.idempotency.fail(claim=claim)
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except HTTPException:
        if reserved:
            await services.quota.refund(user_id_hash=context.session.user_id_hash, request_id=operation_id)
        if claim and not claim.completed:
            await services.idempotency.fail(claim=claim)
        raise
    except Exception as exc:
        if reserved:
            await services.quota.refund(user_id_hash=context.session.user_id_hash, request_id=operation_id)
        if claim:
            await services.idempotency.fail(claim=claim)
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

    Does not call external TTS providers. This can be used by guest/frontend code
    to decide whether to use browser TTS locally.
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
            authenticated=bool(context.session.authenticated),
            locale=policy.locale,
            voice_id=policy.voice_id,
            speaking_rate=policy.speaking_rate,
            format=policy.format,
            browser_fallback_allowed=policy.browser_fallback_allowed,
            external_tts_allowed=policy.external_tts_allowed,
            reason=policy.reason,
        )

    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
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
    context: AuthenticatedRequestContextDep,
) -> dict[str, Any]:
    """
    TTS subsystem health.

    Does not expose provider credentials or raw synthesis payloads.
    """
    assert_authenticated(context)
    return {"status": "ok", "request_id": context.request_id}


