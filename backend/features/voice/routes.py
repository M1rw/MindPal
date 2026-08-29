# backend/features/voice/routes.py

"""
Voice V4 and Text-to-Speech HTTP endpoints.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status

from backend.api.dependencies import AuthenticatedRequestContextDep, RequestContextDep, ServicesDep, assert_authenticated, http_error_from_app_error
from backend.core.errors import AppError
from backend.models.feature_flags import FeatureContext
from backend.models.schemas import TTSRequest, TTSResponse
from .schemas import VOICE_V4_FEATURE_KEY, VoiceV4Contract
from .token_service import VoiceV4TokenGrant

router = APIRouter(prefix="/api", tags=["voice"])


@router.post("/tts", response_model=TTSResponse)
async def synthesize_speech(
    payload: TTSRequest,
    services: ServicesDep,
    context: RequestContextDep,
) -> TTSResponse:
    try:
        return await services.tts.synthesize(payload)
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "tts_synthesis_failed", "message": "Failed to synthesize speech", "request_id": context.request_id},
        ) from exc


@router.post("/voice/v4/token")
async def issue_voice_v4_token(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> dict[str, object]:
    assert_authenticated(context)
    feature_ctx = FeatureContext(
        user_id_hash=context.session.user_id_hash,
        authenticated=True,
        channel=context.session.channel.value if hasattr(context.session.channel, "value") else str(context.session.channel),
        locale=context.session.locale,
    )
    feature = await services.feature_flags.evaluate(VOICE_V4_FEATURE_KEY, feature_ctx)

    try:
        grant: VoiceV4TokenGrant = await services.voice_v4_tokens.issue_token(
            feature=feature,
            feature_context=feature_ctx,
            request_id=context.request_id,
        )
        return grant.to_public_dict()
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
