from __future__ import annotations

import asyncio
import base64
import datetime as dt
import hashlib
import hmac
import io
import json
import logging
import secrets
import wave
from typing import Any

from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.api.dependencies import (
    AuthenticatedRequestContextDep,
    ServicesDep,
    assert_authenticated,
    http_error_from_app_error,
)
from backend.core.errors import AppError
from backend.core.freshness import requires_verified_web_search
from backend.core.security import sanitize_text
from backend.models.schemas import TTSFormat
from backend.services.persona_voice_catalog import PersonaVoiceCatalog
from backend.tools import ToolContext, build_default_registry
from backend.tools.voice_tools import VoiceSummarizeTool, VoiceTranscribeTool

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/voice", tags=["voice"])

MAX_AUDIO_BASE64_CHARS = 15_000_000
MAX_TRANSCRIPT_CHARS = 4_000
MAX_MIME_TYPE_CHARS = 80
MAX_VOICE_FACT_QUERY_CHARS = 500
FALLBACK_GRANT_TTL_SECONDS = 120
NATIVE_AUDIO_LIVE_MODEL_PREFIX = "gemini-2.5-flash-native-audio"
GEMINI_25_LIVE_MODEL_PREFIX = NATIVE_AUDIO_LIVE_MODEL_PREFIX
GEMINI_31_LIVE_MODEL_PREFIX = "gemini-3.1-flash-live"

_summarize_tool = VoiceSummarizeTool()
_transcribe_tool = VoiceTranscribeTool()
_verified_fact_registry = None
_REALTIME_TTS_CACHE: dict[tuple[str, str, str, int], tuple[str, int, str]] = {}
_PERSONA_VOICE_CATALOG: PersonaVoiceCatalog | None = None
_REALTIME_TTS_CACHE_MAX_ENTRIES = 32
_REALTIME_TTS_COMMON_CUES = frozenset({"mhm", "yeah", "aha", "right", "okay"})
_REALTIME_TTS_EMOTIONS = frozenset({"neutral", "calm", "empathetic", "concerned", "attentive", "soft"})


def _get_persona_voice_catalog() -> PersonaVoiceCatalog:
    global _PERSONA_VOICE_CATALOG
    if _PERSONA_VOICE_CATALOG is None:
        _PERSONA_VOICE_CATALOG = PersonaVoiceCatalog()
    return _PERSONA_VOICE_CATALOG


def _get_verified_fact_registry():
    global _verified_fact_registry
    if _verified_fact_registry is None:
        _verified_fact_registry = build_default_registry()
    return _verified_fact_registry


class TranscribeRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    audio_base64: str = Field(min_length=1, max_length=MAX_AUDIO_BASE64_CHARS)
    mime_type: str = Field(default="audio/webm", max_length=MAX_MIME_TYPE_CHARS)

    @field_validator("mime_type", mode="before")
    @classmethod
    def _clean_mime_type(cls, value: object) -> str:
        raw = sanitize_text(str(value or "audio/webm"), MAX_MIME_TYPE_CHARS)
        mime = raw.split(";")[0].strip() or "audio/webm"
        if not mime.startswith("audio/"):
            raise ValueError("mime_type must be an audio MIME type")
        return mime


class TranscribeResponse(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    text: str
    request_id: str
    usage: dict[str, int] | None = None


class SummarizeRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    user_transcript: str = Field(default="", max_length=MAX_TRANSCRIPT_CHARS)
    ai_transcript: str = Field(default="", max_length=MAX_TRANSCRIPT_CHARS)

    @field_validator("user_transcript", "ai_transcript", mode="before")
    @classmethod
    def _clean_transcript(cls, value: object) -> str:
        return sanitize_text(str(value or ""), MAX_TRANSCRIPT_CHARS)


class SummarizeResponse(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    summary: str
    request_id: str
    usage: dict[str, int] | None = None


class VoiceTokenResponse(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    token: str = Field(min_length=1, max_length=8_000)
    model: str = Field(min_length=1, max_length=120)
    websocket_url: str = Field(min_length=1, max_length=500)
    expires_at: str
    new_session_expires_at: str
    usage: dict[str, int] | None = None
    fallback_grant: str | None = None
    fallback_used: bool = False
class RealtimeVoiceTtsRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid", populate_by_name=True)
    text: str = Field(min_length=1, max_length=40)
    persona: str = Field(min_length=1, max_length=120)
    emotion: str = Field(default="neutral", max_length=40)
    format: str = Field(default="pcm16", pattern=r"^pcm16$")
    sample_rate: int = Field(default=24_000, alias="sampleRate", serialization_alias="sampleRate", ge=24_000, le=24_000)

    @field_validator("text", "persona", "emotion", mode="before")
    @classmethod
    def _clean_realtime_tts_text(cls, value: object) -> str:
        return sanitize_text(str(value or ""), 120)


class RealtimeVoiceTtsResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    audio_base64: str = Field(default="", min_length=0, alias="audioBase64", serialization_alias="audioBase64")
    duration_ms: int = Field(gt=0, le=2_000, alias="durationMs", serialization_alias="durationMs")
    cached: bool = False
    voice_id: str | None = Field(default=None, alias="voiceId", serialization_alias="voiceId")
    persona: str
    fallback: str | None = None


class VoiceTransportDiagnosticRequest(BaseModel):
    """Sanitized client-side Live transport metadata for production diagnosis."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    model: str = Field(min_length=1, max_length=120)
    close_code: int = Field(ge=0, le=5_000)
    close_reason: str = Field(default="", max_length=500)
    was_clean: bool
    setup_complete: bool
    greeting_sent: bool
    duration_ms: int = Field(ge=0, le=1_800_000)

    @field_validator("model", "close_reason", mode="before")
    @classmethod
    def _clean_transport_detail(cls, value: object) -> str:
        return sanitize_text(str(value or ""), 500)


class VoiceDeliveryDiagnosticRequest(BaseModel):
    """Aggregate Live delivery counters for caption and turn debugging only."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    model: str = Field(min_length=1, max_length=120)
    audio_parts: int = Field(ge=0, le=100_000)
    input_transcription_events: int = Field(ge=0, le=10_000)
    output_transcription_events: int = Field(ge=0, le=10_000)
    transcript_callback_events: int = Field(ge=0, le=10_000)
    model_text_parts: int = Field(ge=0, le=100_000)
    turn_complete_events: int = Field(ge=0, le=10_000)
    interrupted_events: int = Field(ge=0, le=10_000)
    fact_gated_audio_parts: int = Field(ge=0, le=100_000)
    end_reason: str = Field(min_length=1, max_length=40, pattern=r"^[a-z_]+$")

    @field_validator("model", "end_reason", mode="before")
    @classmethod
    def _clean_delivery_detail(cls, value: object) -> str:
        return sanitize_text(str(value or ""), 120)


class VoiceVerifiedFactRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    query: str = Field(min_length=1, max_length=MAX_VOICE_FACT_QUERY_CHARS)

    @field_validator("query", mode="before")
    @classmethod
    def _clean_query(cls, value: object) -> str:
        return sanitize_text(str(value or ""), MAX_VOICE_FACT_QUERY_CHARS)


class VoiceVerifiedFactResponse(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    query: str
    required: bool
    verified: bool
    evidence: dict[str, Any] | None = None
    error: str | None = None
    request_id: str


@router.post("/transcribe", response_model=TranscribeResponse)
async def transcribe_audio(
    payload: TranscribeRequest,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> TranscribeResponse:
    assert_authenticated(context)
    operation_id = _operation_id(context.request_id, "voice-transcribe")
    claim = None
    reserved = False
    try:
        await services.rate_limits.consume(
            scope="voice_transcribe",
            subject=context.session.user_id_hash,
            limit=services.settings.VOICE_RATE_LIMIT_PER_MINUTE,
            window_seconds=60,
        )
        claim = await services.idempotency.claim(
            user_id_hash=context.session.user_id_hash,
            key=context.request_id,
            operation="voice_transcribe",
            payload_hash=services.idempotency.payload_hash(payload.model_dump(mode="json")),
        )
        if claim.completed and claim.response:
            return TranscribeResponse.model_validate(claim.response)

        await services.quota.reserve(
            user_id_hash=context.session.user_id_hash,
            request_id=operation_id,
            cost=services.settings.PROVIDER_OPERATION_QUOTA_COST,
            operation="voice_transcribe",
        )
        reserved = True
        result = await _transcribe_tool.execute(
            {"audio_base64": payload.audio_base64, "mime_type": payload.mime_type},
            _tool_context(context, services),
        )
        if not result.ok:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail={
                    "code": "transcription_failed",
                    "message": result.error or "Audio transcription failed",
                    "request_id": context.request_id,
                },
            )
        usage = await services.quota.commit(user_id_hash=context.session.user_id_hash, request_id=operation_id)
        response = TranscribeResponse(text=result.data.get("text", ""), request_id=context.request_id, usage=usage.to_dict())
        await services.idempotency.complete(claim=claim, response=response.model_dump(mode="json"))
        return response
    except AppError as exc:
        if reserved:
            await services.quota.refund(user_id_hash=context.session.user_id_hash, request_id=operation_id)
        if claim:
            await services.idempotency.fail(claim=claim)
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except HTTPException:
        if reserved:
            await services.quota.refund(user_id_hash=context.session.user_id_hash, request_id=operation_id)
        if claim:
            await services.idempotency.fail(claim=claim)
        raise
    except Exception as exc:
        if reserved:
            await services.quota.refund(user_id_hash=context.session.user_id_hash, request_id=operation_id)
        if claim:
            await services.idempotency.fail(claim=claim)
        logger.exception("Voice transcription failed")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"code": "transcription_failed", "message": "Audio transcription failed", "request_id": context.request_id},
        ) from exc


@router.post("/summarize", response_model=SummarizeResponse)
async def summarize_call(
    payload: SummarizeRequest,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> SummarizeResponse:
    assert_authenticated(context)
    operation_id = _operation_id(context.request_id, "voice-summary")
    claim = None
    reserved = False
    try:
        await services.rate_limits.consume(
            scope="voice_summary",
            subject=context.session.user_id_hash,
            limit=services.settings.VOICE_RATE_LIMIT_PER_MINUTE,
            window_seconds=60,
        )
        claim = await services.idempotency.claim(
            user_id_hash=context.session.user_id_hash,
            key=context.request_id,
            operation="voice_summary",
            payload_hash=services.idempotency.payload_hash(payload.model_dump(mode="json")),
        )
        if claim.completed and claim.response:
            return SummarizeResponse.model_validate(claim.response)
        await services.quota.reserve(
            user_id_hash=context.session.user_id_hash,
            request_id=operation_id,
            cost=services.settings.PROVIDER_OPERATION_QUOTA_COST,
            operation="voice_summary",
        )
        reserved = True
        result = await _summarize_tool.execute(payload.model_dump(mode="json"), _tool_context(context, services))
        if not result.ok:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail={"code": "voice_summary_failed", "message": "Voice summarization failed", "request_id": context.request_id},
            )
        usage = await services.quota.commit(user_id_hash=context.session.user_id_hash, request_id=operation_id)
        response = SummarizeResponse(
            summary=sanitize_text(result.data.get("summary", "Voice call"), 300) or "Voice call",
            request_id=context.request_id,
            usage=usage.to_dict(),
        )
        await services.idempotency.complete(claim=claim, response=response.model_dump(mode="json"))
        return response
    except AppError as exc:
        if reserved:
            await services.quota.refund(user_id_hash=context.session.user_id_hash, request_id=operation_id)
        if claim:
            await services.idempotency.fail(claim=claim)
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except HTTPException:
        if reserved:
            await services.quota.refund(user_id_hash=context.session.user_id_hash, request_id=operation_id)
        if claim:
            await services.idempotency.fail(claim=claim)
        raise
    except Exception as exc:
        if reserved:
            await services.quota.refund(user_id_hash=context.session.user_id_hash, request_id=operation_id)
        if claim:
            await services.idempotency.fail(claim=claim)
        logger.exception("Voice summarization failed")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"code": "voice_summary_failed", "message": "Voice summarization failed", "request_id": context.request_id},
        ) from exc


@router.post("/verify-current-fact", response_model=VoiceVerifiedFactResponse)
async def verify_current_voice_fact(
    payload: VoiceVerifiedFactRequest,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> VoiceVerifiedFactResponse:
    """Return backend-verified web evidence before Voice may speak volatile facts."""
    assert_authenticated(context)
    query = payload.query
    required = requires_verified_web_search(query)
    if not required:
        return VoiceVerifiedFactResponse(
            query=query,
            required=False,
            verified=False,
            error="verification_not_required",
            request_id=context.request_id,
        )

    await services.rate_limits.consume(
        scope="tools",
        subject=context.session.user_id_hash,
        limit=services.settings.TOOL_RATE_LIMIT_PER_MINUTE,
        window_seconds=60,
    )
    await services.rate_limits.consume(
        scope="web_search",
        subject=context.session.user_id_hash,
        limit=services.settings.WEB_SEARCH_RATE_LIMIT_PER_HOUR,
        window_seconds=3600,
    )

    tool_context = ToolContext(
        user_id_hash=context.session.user_id_hash,
        authenticated=True,
        locale=getattr(context, "locale", "auto"),
        timezone=getattr(context, "timezone", "UTC"),
        request_id=context.request_id,
        services=services,
    )
    result = await _get_verified_fact_registry().execute("web_search", {"query": query}, tool_context)
    evidence = result.to_dict() if result.ok else {}
    search_results = evidence.get("data", {}).get("results") if isinstance(evidence.get("data"), dict) else None
    if not result.ok or not isinstance(search_results, list) or not search_results:
        return VoiceVerifiedFactResponse(
            query=query,
            required=True,
            verified=False,
            error="verification_unavailable",
            request_id=context.request_id,
        )

    return VoiceVerifiedFactResponse(
        query=query,
        required=True,
        verified=True,
        evidence=evidence,
        request_id=context.request_id,
    )


@router.get("/token", response_model=VoiceTokenResponse)
async def get_voice_token(
    response: Response,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
    fallback_grant: str | None = None,
) -> VoiceTokenResponse:
    assert_authenticated(context)
    operation_id = _operation_id(context.request_id, "voice-token")
    claim = None
    reserved = False
    fallback_only = bool(fallback_grant)
    try:
        await services.rate_limits.consume(
            scope="voice_token_fallback" if fallback_only else "voice_token",
            subject=context.session.user_id_hash,
            limit=services.settings.VOICE_TOKEN_RATE_LIMIT_PER_HOUR,
            window_seconds=3600,
        )
        api_key = _secret_value(services.settings.GEMINI_API_KEY)
        if not api_key:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={"code": "gemini_not_configured", "message": "Voice service is not available", "request_id": context.request_id},
            )
        now = dt.datetime.now(tz=dt.timezone.utc)
        expires_at = now + dt.timedelta(seconds=int(services.settings.VOICE_TOKEN_TTL_SECONDS))
        new_session_expires_at = now + dt.timedelta(seconds=int(services.settings.VOICE_NEW_SESSION_TTL_SECONDS))
        primary_model = sanitize_text(services.settings.GEMINI_LIVE_MODEL, 120)
        fallback_model = sanitize_text(services.settings.GEMINI_LIVE_FALLBACK_MODEL, 120)
        invalid_models = [model for model in (primary_model, fallback_model) if model and not _is_supported_gemini_api_live_model(model)]
        if invalid_models:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail={"code": "gemini_live_model_unsupported", "message": "Configured Voice model is not supported by the Gemini API Live WebSocket", "request_id": context.request_id})
        if fallback_only:
            grant_payload = _verify_fallback_grant(
                grant=fallback_grant or "",
                secret=api_key,
                user_id_hash=context.session.user_id_hash,
                expected_primary=primary_model,
                expected_fallback=fallback_model,
                now=now,
            )
            if not primary_model.startswith("gemini-3.1-") or not fallback_model or fallback_model == primary_model:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"code": "voice_fallback_unavailable", "message": "No distinct configured Voice fallback is available"})
            operation_id = _operation_id(str(grant_payload["nonce"]), "voice-token-fallback")
            claim = await services.idempotency.claim(
                user_id_hash=context.session.user_id_hash,
                key=str(grant_payload["nonce"]),
                operation="voice_live_token_fallback",
                payload_hash=services.idempotency.payload_hash({"grant": fallback_grant, "model": fallback_model}),
            )
            if claim.completed:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"code": "voice_fallback_already_used", "message": "This Voice fallback grant was already used"})
            candidate_models = [fallback_model]
        else:
            claim = await services.idempotency.claim(
                user_id_hash=context.session.user_id_hash,
                key=context.request_id,
                operation="voice_live_token",
                payload_hash=services.idempotency.payload_hash({"model": primary_model}),
            )
            if claim.completed:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={
                        "code": "idempotent_result_not_replayable",
                        "message": "This voice token request already completed; request a new token with a new request ID",
                        "request_id": context.request_id,
                    },
                )
            await services.quota.reserve(
                user_id_hash=context.session.user_id_hash,
                request_id=operation_id,
                cost=services.settings.VOICE_SESSION_QUOTA_COST,
                operation="voice_live_session",
            )
            reserved = True
            candidate_models = [primary_model]
            if fallback_model and fallback_model != primary_model:
                candidate_models.append(fallback_model)

        token_name = ""
        live_model = candidate_models[0]
        last_provision_error: Exception | None = None
        for candidate_model in candidate_models:
            api_version = _live_api_version(candidate_model)
            try:
                token_name = await _create_ephemeral_voice_token(
                    api_key=api_key,
                    model=candidate_model,
                    api_version=api_version,
                    expires_at=expires_at,
                    new_session_expires_at=new_session_expires_at,
                )
                live_model = candidate_model
                break
            except Exception as exc:
                last_provision_error = exc
                if candidate_model != candidate_models[-1]:
                    logger.warning("Primary Gemini Live model provisioning failed; trying fallback model=%s", fallback_model)
                    continue
                raise
        if not token_name:
            raise last_provision_error or RuntimeError("Gemini returned an empty ephemeral token")

        api_version = _live_api_version(live_model)
        usage = None if fallback_only else await services.quota.commit(user_id_hash=context.session.user_id_hash, request_id=operation_id)
        await services.idempotency.complete(claim=claim, response={"completed": True})
        response.headers["Cache-Control"] = "no-store, private"
        response.headers["Pragma"] = "no-cache"
        grant = None
        if not fallback_only and primary_model.startswith("gemini-3.1-") and fallback_model and fallback_model != primary_model and live_model == primary_model:
            grant = _create_fallback_grant(
                secret=api_key,
                user_id_hash=context.session.user_id_hash,
                primary_model=primary_model,
                fallback_model=fallback_model,
                request_id=context.request_id,
                now=now,
            )
        return VoiceTokenResponse(
            token=token_name,
            model=live_model,
            websocket_url=_live_websocket_url(api_version),
            expires_at=expires_at.isoformat().replace("+00:00", "Z"),
            new_session_expires_at=new_session_expires_at.isoformat().replace("+00:00", "Z"),
            usage=usage.to_dict() if usage else None,
            fallback_grant=grant,
            fallback_used=live_model != primary_model,
        )
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
    except ModuleNotFoundError as exc:
        if reserved:
            await services.quota.refund(user_id_hash=context.session.user_id_hash, request_id=operation_id)
        if claim:
            await services.idempotency.fail(claim=claim)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": "voice_dependency_missing", "message": "Voice service is temporarily unavailable", "request_id": context.request_id},
        ) from exc
    except Exception as exc:
        if reserved:
            await services.quota.refund(user_id_hash=context.session.user_id_hash, request_id=operation_id)
        if claim:
            await services.idempotency.fail(claim=claim)
        logger.exception("Failed to provision Gemini Live ephemeral token")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"code": "voice_token_provision_failed", "message": "Could not start a secure voice session", "request_id": context.request_id},
        ) from exc


@router.get("/v3/personas")
async def list_realtime_voice_personas(
    context: AuthenticatedRequestContextDep,
) -> dict[str, Any]:
    """Return non-secret Gemini Native Audio persona metadata for internal review."""
    assert_authenticated(context)
    return {
        "provider": "gemini-native-audio",
        "persona_voice_catalog": {
            "Kore": {
                "persona": "Kore",
                "voice_name": "Kore",
                "voice_id": "Kore",
                "provider": "gemini",
                "gender": "unspecified",
                "style": "native-audio",
            },
            "Charon": {
                "persona": "Charon",
                "voice_name": "Charon",
                "voice_id": "Charon",
                "provider": "gemini",
                "gender": "unspecified",
                "style": "native-audio",
            },
        },
        "fallback_policy": "No external voice fallback is used by the Gemini-only V3 path.",
    }


@router.post("/v3/tts", response_model=RealtimeVoiceTtsResponse)
async def synthesize_realtime_voice_tts(
    payload: RealtimeVoiceTtsRequest,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> RealtimeVoiceTtsResponse:
    """Generate a short cue only when the persona has an explicit voice mapping."""
    assert_authenticated(context)
    catalog = _get_persona_voice_catalog()
    voice = catalog.resolve(payload.persona)
    if voice is None or not voice.voice_id:
        logger.warning("tts.persona_mapping_missing persona=%s request_id=%s", sanitize_text(payload.persona, 120), context.request_id)
        logger.info("tts.fallback.nonverbal reason=persona_mapping_missing request_id=%s", context.request_id)
        return _nonverbal_tts_response(payload.persona)

    text = payload.text.lower()
    emotion = sanitize_text(payload.emotion, 40).lower() or "neutral"
    cache_key = (voice.persona.lower(), emotion, text, payload.sample_rate)
    if text in _REALTIME_TTS_COMMON_CUES:
        cached = _REALTIME_TTS_CACHE.get(cache_key)
        if cached:
            logger.info("tts.cache.hit persona=%s emotion=%s request_id=%s", voice.persona, emotion, context.request_id)
            return RealtimeVoiceTtsResponse(
                audioBase64=cached[0], durationMs=cached[1], cached=True, voiceId=cached[2], persona=voice.persona,
            )
    logger.info("tts.cache.miss persona=%s emotion=%s request_id=%s", voice.persona, emotion, context.request_id)
    logger.info("tts.request.started persona=%s emotion=%s request_id=%s", voice.persona, emotion, context.request_id)

    await services.rate_limits.consume(
        scope="tts",
        subject=context.session.user_id_hash,
        limit=services.settings.TTS_RATE_LIMIT_PER_MINUTE,
        window_seconds=60,
    )
    emotion_supported = emotion == "neutral" or (emotion in _REALTIME_TTS_EMOTIONS and voice.supports_emotion)
    if emotion != "neutral" and not emotion_supported:
        logger.info("tts.emotion_unsupported persona=%s provider=%s emotion=%s request_id=%s", voice.persona, voice.tts_provider, emotion, context.request_id)
    response_mode = emotion if emotion_supported else "normal_support"
    try:
        result = await services.tts.synthesize_text(
            text=payload.text,
            locale=getattr(context, "locale", "auto"),
            response_mode=response_mode,
            safety_level="safe",
            voice_id=voice.voice_id,
            format=TTSFormat.WAV,
            speaking_rate=1.0,
            allow_external_for_crisis=False,
        )
        if result.fallback_to_browser or not result.audio_base64:
            logger.info("tts.fallback.nonverbal reason=provider_unavailable request_id=%s", context.request_id)
            return _nonverbal_tts_response(voice.persona, voice.voice_id)
        try:
            source_bytes = base64.b64decode(result.audio_base64, validate=True)
            pcm_bytes, source_rate = _wav_to_pcm16(source_bytes)
            normalized_pcm = _resample_pcm16_mono(pcm_bytes, source_rate, payload.sample_rate)
        except (ValueError, wave.Error, EOFError) as exc:
            logger.warning("tts.request.failed code=malformed_audio request_id=%s", context.request_id)
            logger.info("tts.fallback.nonverbal reason=malformed_audio request_id=%s", context.request_id)
            return _nonverbal_tts_response(voice.persona, voice.voice_id)
        encoded = base64.b64encode(normalized_pcm).decode("ascii")
        duration_ms = max(1, round(len(normalized_pcm) / 2 / payload.sample_rate * 1_000))
        if text in _REALTIME_TTS_COMMON_CUES:
            _REALTIME_TTS_CACHE[cache_key] = (encoded, duration_ms, voice.voice_id)
            while len(_REALTIME_TTS_CACHE) > _REALTIME_TTS_CACHE_MAX_ENTRIES:
                _REALTIME_TTS_CACHE.pop(next(iter(_REALTIME_TTS_CACHE)))
        logger.info("tts.request.success persona=%s provider=%s request_id=%s", voice.persona, voice.tts_provider, context.request_id)
        logger.info("tts.duration_ms value=%s persona=%s request_id=%s", duration_ms, voice.persona, context.request_id)
        return RealtimeVoiceTtsResponse(
            audioBase64=encoded, durationMs=duration_ms, cached=False, voiceId=voice.voice_id, persona=voice.persona,
        )
    except AppError as exc:
        logger.warning("tts.request.failed code=%s request_id=%s", sanitize_text(exc.code, 120), context.request_id)
        logger.info("tts.fallback.nonverbal reason=service_error request_id=%s", context.request_id)
        return _nonverbal_tts_response(voice.persona, voice.voice_id)
    except Exception as exc:
        logger.exception("tts.request.failed request_id=%s", context.request_id)
        logger.info("tts.fallback.nonverbal reason=unexpected_error request_id=%s", context.request_id)
        return _nonverbal_tts_response(voice.persona, voice.voice_id)


@router.post("/transport-diagnostic", status_code=status.HTTP_204_NO_CONTENT)
async def report_voice_transport_diagnostic(
    payload: VoiceTransportDiagnosticRequest,
    context: AuthenticatedRequestContextDep,
) -> Response:
    """Record sanitized close metadata without accepting speech or transcript data."""
    assert_authenticated(context)
    logger.warning(
        "Voice Live transport closed: model=%s code=%s clean=%s setup=%s greeting=%s duration_ms=%s reason=%s request_id=%s",
        payload.model,
        payload.close_code,
        payload.was_clean,
        payload.setup_complete,
        payload.greeting_sent,
        payload.duration_ms,
        payload.close_reason,
        context.request_id,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/delivery-diagnostic", status_code=status.HTTP_204_NO_CONTENT)
async def report_voice_delivery_diagnostic(
    payload: VoiceDeliveryDiagnosticRequest,
    context: AuthenticatedRequestContextDep,
) -> Response:
    """Record aggregate delivery counters without receiving private Voice content."""
    assert_authenticated(context)
    logger.info(
        "Voice Live delivery: model=%s audio_parts=%s input_tx=%s output_tx=%s callbacks=%s text_parts=%s turns=%s interruptions=%s fact_gated_audio=%s end=%s request_id=%s",
        payload.model,
        payload.audio_parts,
        payload.input_transcription_events,
        payload.output_transcription_events,
        payload.transcript_callback_events,
        payload.model_text_parts,
        payload.turn_complete_events,
        payload.interrupted_events,
        payload.fact_gated_audio_parts,
        payload.end_reason,
        context.request_id,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/key", status_code=status.HTTP_410_GONE)
async def retired_voice_key_endpoint(context: AuthenticatedRequestContextDep) -> None:
    assert_authenticated(context)
    raise HTTPException(
        status_code=status.HTTP_410_GONE,
        detail={"code": "voice_key_endpoint_retired", "message": "Use the secure voice token endpoint", "request_id": context.request_id},
    )


async def _create_ephemeral_voice_token(
    *,
    api_key: str,
    model: str,
    api_version: str,
    expires_at: dt.datetime,
    new_session_expires_at: dt.datetime,
) -> str:
    def create() -> str:
        from google import genai

        client = genai.Client(api_key=api_key, http_options={"api_version": api_version})
        try:
            # Match Google’s maintained ephemeral-token WebSocket example:
            # single-use, short-lived token, with the browser sending the Live
            # setup frame after connecting to BidiGenerateContentConstrained.
            # Model/config locking is intentionally omitted for this compatibility
            # path because both constrained resource forms timed out in production.
            token = client.auth_tokens.create(
                config={
                    "uses": 1,
                    "expire_time": expires_at,
                    "new_session_expire_time": new_session_expires_at,
                    "http_options": {"api_version": api_version},
                }
            )
            name = str(getattr(token, "name", "") or "").strip()
            if not name:
                raise RuntimeError("Gemini returned an empty ephemeral token")
            return name
        finally:
            client.close()

    return await asyncio.to_thread(create)


def _nonverbal_tts_response(persona: str, voice_id: str | None = None) -> RealtimeVoiceTtsResponse:
    return RealtimeVoiceTtsResponse(
        audioBase64="",
        durationMs=300,
        cached=False,
        voiceId=voice_id,
        persona=sanitize_text(persona, 120) or "unknown",
        fallback="non_verbal_hum",
    )


def _wav_to_pcm16(audio_bytes: bytes) -> tuple[bytes, int]:
    with wave.open(io.BytesIO(audio_bytes), "rb") as wav_file:
        channels = wav_file.getnchannels()
        sample_width = wav_file.getsampwidth()
        sample_rate = wav_file.getframerate()
        if channels < 1 or sample_width != 2 or sample_rate <= 0:
            raise ValueError("TTS audio must be signed 16-bit PCM")
        frames = wav_file.readframes(wav_file.getnframes())
    if not frames:
        raise ValueError("TTS audio was empty")
    if channels == 1:
        return frames, sample_rate
    samples = memoryview(frames).cast("h")
    mono = bytearray()
    for index in range(0, len(samples), channels):
        available = min(channels, len(samples) - index)
        total = sum(int(samples[index + channel]) for channel in range(available))
        mono.extend(int(total / available).to_bytes(2, "little", signed=True))
    return bytes(mono), sample_rate


def _resample_pcm16_mono(audio_bytes: bytes, source_rate: int, target_rate: int) -> bytes:
    if source_rate == target_rate:
        return audio_bytes
    if len(audio_bytes) % 2:
        raise ValueError("PCM16 audio has an incomplete sample")
    source_samples = memoryview(audio_bytes).cast("h")
    target_length = max(1, round(len(source_samples) * target_rate / source_rate))
    output = bytearray(target_length * 2)
    for index in range(target_length):
        source_position = index * (len(source_samples) - 1) / max(1, target_length - 1)
        left = int(source_position)
        right = min(left + 1, len(source_samples) - 1)
        fraction = source_position - left
        sample = round(source_samples[left] + (source_samples[right] - source_samples[left]) * fraction)
        output[index * 2:index * 2 + 2] = int(max(-32768, min(32767, sample))).to_bytes(2, "little", signed=True)
    return bytes(output)


def _is_supported_gemini_api_live_model(model: str) -> bool:
    normalized = sanitize_text(model, 120).lower()
    return normalized.startswith((NATIVE_AUDIO_LIVE_MODEL_PREFIX, GEMINI_31_LIVE_MODEL_PREFIX))


def _live_model_resource_name(model: str) -> str:
    # The constrained token must authorize the same resource name that the
    # browser sends in BidiGenerateContentSetup. The REST reference uses the
    # full models/{model} form; normalize both bare and prefixed input to it.
    normalized = sanitize_text(model, 120).strip().removeprefix("models/")
    return f"models/{normalized}"


def _live_api_version(model: str) -> str:
    # Google’s maintained ephemeral-token WebSocket example uses the v1alpha
    # constrained service. Isolate that compatibility path for Gemini 2.5;
    # retain v1beta for Gemini 3.1 until it is independently verified.
    normalized = sanitize_text(model, 120).lower()
    if normalized.startswith(NATIVE_AUDIO_LIVE_MODEL_PREFIX):
        return "v1alpha"
    return "v1beta"


def _live_websocket_url(api_version: str) -> str:
    return (
        "wss://generativelanguage.googleapis.com/ws/"
        f"google.ai.generativelanguage.{api_version}.GenerativeService.BidiGenerateContentConstrained"
    )


def _tool_context(context: Any, services: Any) -> ToolContext:
    return ToolContext(
        user_id_hash=context.session.user_id_hash,
        authenticated=True,
        locale=context.locale,
        request_id=context.request_id,
        services=services,
    )


def _operation_id(request_id: str, operation: str) -> str:
    return sanitize_text(f"{request_id}:{operation}", 120)


def _secret_value(value: Any) -> str:
    if hasattr(value, "get_secret_value"):
        return str(value.get_secret_value() or "").strip()
    return str(value or "").strip()


def _create_fallback_grant(*, secret: str, user_id_hash: str, primary_model: str, fallback_model: str, request_id: str, now: dt.datetime) -> str:
    payload = {
        "v": 1,
        "nonce": secrets.token_urlsafe(18),
        "user": sanitize_text(user_id_hash, 120),
        "primary": sanitize_text(primary_model, 120),
        "fallback": sanitize_text(fallback_model, 120),
        "request": sanitize_text(request_id, 120),
        "exp": int((now + dt.timedelta(seconds=FALLBACK_GRANT_TTL_SECONDS)).timestamp()),
    }
    encoded = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    signature = hmac.new(secret.encode("utf-8"), encoded, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(encoded + b"." + signature).decode("ascii").rstrip("=")


def _verify_fallback_grant(*, grant: str, secret: str, user_id_hash: str, expected_primary: str, expected_fallback: str, now: dt.datetime) -> dict[str, Any]:
    try:
        padded = str(grant or "") + "=" * (-len(str(grant or "")) % 4)
        decoded = base64.urlsafe_b64decode(padded.encode("ascii"))
        signature_size = hashlib.sha256().digest_size
        separator_index = len(decoded) - signature_size - 1
        if separator_index <= 0 or decoded[separator_index:separator_index + 1] != b".":
            raise ValueError("invalid grant framing")
        encoded = decoded[:separator_index]
        supplied_signature = decoded[separator_index + 1:]
        expected_signature = hmac.new(secret.encode("utf-8"), encoded, hashlib.sha256).digest()
        if not hmac.compare_digest(supplied_signature, expected_signature):
            raise ValueError("invalid signature")
        payload = json.loads(encoded.decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("grant payload must be an object")
        if payload.get("v") != 1 or int(payload.get("exp", 0)) <= int(now.timestamp()):
            raise ValueError("expired grant")
        if payload.get("user") != sanitize_text(user_id_hash, 120):
            raise ValueError("grant user mismatch")
        if payload.get("primary") != sanitize_text(expected_primary, 120):
            raise ValueError("grant primary mismatch")
        if payload.get("fallback") != sanitize_text(expected_fallback, 120):
            raise ValueError("grant fallback mismatch")
        if not sanitize_text(str(payload.get("nonce") or ""), 120):
            raise ValueError("grant nonce missing")
        return payload
    except (ValueError, TypeError, KeyError, OverflowError, json.JSONDecodeError, UnicodeError) as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail={"code": "voice_fallback_grant_invalid", "message": "Voice fallback authorization is invalid or expired"}) from exc
