from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict

from backend.api.dependencies import (
    AuthenticatedRequestContextDep,
    ServicesDep,
    assert_authenticated,
    http_error_from_app_error,
)
from backend.core.errors import AppError
from backend.models.feature_flags import FeatureContext
from backend.services.feature_flags_service import FeatureFlagsService


router = APIRouter(prefix="/api/voice/v4", tags=["voice-v4"])


class VoiceV4TokenResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    token: str
    expires_at_utc: str
    new_session_expires_at_utc: str
    model: str
    protocol_version: str
    request_id: str


@router.post("/token", response_model=VoiceV4TokenResponse)
async def issue_voice_v4_token(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> VoiceV4TokenResponse:
    """Issue one constrained, short-lived Live token for a future browser layer."""

    assert_authenticated(context)
    feature_state = await services.feature_policies.load()
    feature_evaluator = FeatureFlagsService(
        registry=services.feature_flags.registry,
        policies=feature_state.policies,
        registry_version=services.feature_flags.registry_version,
    )
    feature_context = FeatureContext(
        user_id_hash=context.session.user_id_hash,
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
        return VoiceV4TokenResponse.model_validate(grant.to_public_dict())
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail={
                "code": "voice_provider_unavailable",
                "message": "Voice V4 token service is temporarily unavailable",
                "request_id": context.request_id,
            },
        ) from exc
