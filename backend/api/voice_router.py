from __future__ import annotations

import asyncio
import datetime as dt
import logging
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
from backend.tools import ToolContext, build_default_registry
from backend.tools.voice_tools import VoiceSummarizeTool, VoiceTranscribeTool

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/voice", tags=["voice"])

MAX_AUDIO_BASE64_CHARS = 15_000_000
MAX_TRANSCRIPT_CHARS = 4_000
MAX_MIME_TYPE_CHARS = 80
MAX_VOICE_FACT_QUERY_CHARS = 500
NATIVE_AUDIO_LIVE_MODEL_PREFIX = "gemini-2.5-flash-native-audio"

_summarize_tool = VoiceSummarizeTool()
_transcribe_tool = VoiceTranscribeTool()
_verified_fact_registry = None


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
) -> VoiceTokenResponse:
    assert_authenticated(context)
    operation_id = _operation_id(context.request_id, "voice-token")
    claim = None
    reserved = False
    try:
        await services.rate_limits.consume(
            scope="voice_token",
            subject=context.session.user_id_hash,
            limit=services.settings.VOICE_TOKEN_RATE_LIMIT_PER_HOUR,
            window_seconds=3600,
        )
        claim = await services.idempotency.claim(
            user_id_hash=context.session.user_id_hash,
            key=context.request_id,
            operation="voice_live_token",
            payload_hash=services.idempotency.payload_hash({"model": services.settings.GEMINI_LIVE_MODEL}),
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
        api_key = _secret_value(services.settings.GEMINI_API_KEY)
        if not api_key:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={"code": "gemini_not_configured", "message": "Voice service is not available", "request_id": context.request_id},
            )
        now = dt.datetime.now(tz=dt.timezone.utc)
        expires_at = now + dt.timedelta(seconds=int(services.settings.VOICE_TOKEN_TTL_SECONDS))
        new_session_expires_at = now + dt.timedelta(seconds=int(services.settings.VOICE_NEW_SESSION_TTL_SECONDS))
        live_model = services.settings.GEMINI_LIVE_MODEL
        api_version = _live_api_version(live_model)
        token_name = await _create_ephemeral_voice_token(
            api_key=api_key,
            model=live_model,
            api_version=api_version,
            expires_at=expires_at,
            new_session_expires_at=new_session_expires_at,
        )
        usage = await services.quota.commit(user_id_hash=context.session.user_id_hash, request_id=operation_id)
        await services.idempotency.complete(claim=claim, response={"completed": True})
        response.headers["Cache-Control"] = "no-store, private"
        response.headers["Pragma"] = "no-cache"
        return VoiceTokenResponse(
            token=token_name,
            model=live_model,
            websocket_url=_live_websocket_url(api_version),
            expires_at=expires_at.isoformat().replace("+00:00", "Z"),
            new_session_expires_at=new_session_expires_at.isoformat().replace("+00:00", "Z"),
            usage=usage.to_dict(),
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
            token = client.auth_tokens.create(
                config={
                    "uses": 1,
                    "expire_time": expires_at,
                    "new_session_expire_time": new_session_expires_at,
                    "live_connect_constraints": {
                        "model": model,
                        "config": {"session_resumption": {}, "response_modalities": ["AUDIO"]},
                    },
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


def _live_api_version(model: str) -> str:
    normalized = sanitize_text(model, 120).lower()
    return "v1beta" if normalized.startswith(NATIVE_AUDIO_LIVE_MODEL_PREFIX) else "v1alpha"


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
