from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict

from backend.api.dependencies import (
    AuthenticatedRequestContextDep,
    ServicesDep,
    assert_authenticated,
    http_error_from_app_error,
)
from backend.core.errors import AppError
from backend.core.security import sanitize_text
from backend.models.feature_flags import FeatureContext

logger = logging.getLogger(__name__)


router = APIRouter(prefix="/api/voice", tags=["voice"])


def _session_email_hash(session: object) -> str | None:
    metadata = getattr(session, "metadata", {})
    value = metadata.get("email_hash") if isinstance(metadata, dict) else None
    return value if isinstance(value, str) and value.strip() else None


class VoiceV4TokenResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    token: str
    expires_at_utc: str
    new_session_expires_at_utc: str
    model: str
    protocol_version: str
    request_id: str


class VoiceSummarizeRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    user_transcript: str = ""
    ai_transcript: str = ""


class VoiceSummarizeResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    summary: str
    request_id: str


MAX_TRANSCRIPT_CHARS = 10_000


@router.post("/summarize", response_model=VoiceSummarizeResponse)
async def summarize_voice_session(
    payload: VoiceSummarizeRequest,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> VoiceSummarizeResponse:
    """Summarize a voice/chat session transcript within 200 tokens."""
    assert_authenticated(context)

    # Rate limit voice summarization calls per user to prevent DoS and LLM budget abuse.
    await services.rate_limits.consume(
        scope="voice_summarize_user",
        subject=context.session.user_id_hash,
        limit=services.settings.VOICE_V4_TOKEN_RATE_LIMIT_PER_MINUTE,
        window_seconds=60,
    )

    user_text = sanitize_text(payload.user_transcript or "", MAX_TRANSCRIPT_CHARS)
    ai_text = sanitize_text(payload.ai_transcript or "", MAX_TRANSCRIPT_CHARS)

    if not user_text and not ai_text:
        return VoiceSummarizeResponse(
            summary="Brief voice interaction with no spoken content recorded.",
            request_id=context.request_id,
        )

    prompt = (
        "Summarize this short voice call transcript between a User and MindPal AI in 1-2 clear, compassionate sentences (max 150 words). "
        "Focus on key emotional themes and practical topics discussed:\n\n"
        f"User: {user_text}\n"
        f"AI: {ai_text}"
    )

    try:
        from backend.services.domain.llm.request_builder import build_llm_request
        llm_req = build_llm_request(
            request_id=context.request_id,
            system_prompt="You are MindPal's call summarization engine. Be concise and supportive.",
            user_message=prompt,
            max_output_tokens=200,
        )
        res = await services.llm.generate_with_trace(llm_req)
        summary = res.response.text.strip() or "Voice session completed."
        return VoiceSummarizeResponse(
            summary=summary,
            request_id=context.request_id,
        )
    except Exception:
        logger.warning("Voice summarization failed for %s", context.request_id, exc_info=True)
        return VoiceSummarizeResponse(
            summary=f"Voice call session ({len(user_text.split()) + len(ai_text.split())} words exchanged).",
            request_id=context.request_id,
        )


@router.post("/v4/token", response_model=VoiceV4TokenResponse)
async def issue_voice_v4_token(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> VoiceV4TokenResponse:
    """Issue one constrained, short-lived Live token for a future browser layer."""

    assert_authenticated(context)

    # Load policies once and evaluate voice feature using the shared service.
    feature_state = await services.feature_policies.load()
    from backend.services.domain.features import FeatureFlagsService
    feature_evaluator = FeatureFlagsService(
        registry=services.feature_flags.registry,
        policies=feature_state.policies,
        registry_version=services.feature_flags.registry_version,
    )
    feature_context = FeatureContext(
        user_id_hash=context.session.user_id_hash,
        email_hash=_session_email_hash(context.session),
        authenticated=True,
        is_admin=await services.admin_authority.is_admin(context.session),
        channel=context.channel.value,
        locale=context.locale,
    )
    feature = feature_evaluator.evaluate("voice.live_v4", feature_context)

    try:
        await services.rate_limits.consume(
            scope="voice_v4_token_user",
            subject=context.session.user_id_hash,
            limit=services.settings.VOICE_V4_TOKEN_RATE_LIMIT_PER_MINUTE,
            window_seconds=60,
        )
        await services.rate_limits.consume(
            scope="voice_v4_token_client",
            subject=context.client_ip_hash,
            limit=services.settings.VOICE_V4_TOKEN_RATE_LIMIT_PER_MINUTE * 2,
            window_seconds=60,
        )
        grant = await services.voice_v4_tokens.issue_token(
            feature=feature,
            feature_context=feature_context,
            request_id=context.request_id,
        )
        logger.info(
            "voice_v4_token_issued request_id=%s model=%s",
            context.request_id,
            grant.model,
        )
        return VoiceV4TokenResponse.model_validate(grant.to_public_dict())
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            "voice_v4_token_unexpected_error request_id=%s",
            context.request_id,
            exc_info=True,
        )
        raise HTTPException(
            status_code=502,
            detail={
                "code": "voice_provider_unavailable",
                "message": "Voice V4 token service is temporarily unavailable",
                "request_id": context.request_id,
            },
        ) from exc
