# backend/features/flags/routes.py

"""
Feature flags HTTP endpoints for public evaluation and admin overrides.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Path, status
from fastapi.responses import JSONResponse

from backend.api.dependencies import (
    AdminRequestContextDep,
    RequestContextDep,
    ServicesDep,
)
from .schemas import (
    EvaluationContext,
    FeatureAdminUpdateRequest,
    FeatureDecision,
    FeaturePolicy,
    FeaturePublicSnapshot,
)

router = APIRouter(prefix="/api/features", tags=["features"])


@router.get("", response_model=FeaturePublicSnapshot)
async def get_feature_snapshot(
    services: ServicesDep,
    context: RequestContextDep,
) -> FeaturePublicSnapshot:
    eval_ctx = EvaluationContext(
        user_id_hash=context.session.user_id_hash,
        authenticated=context.authenticated,
        is_admin=getattr(context.session, "is_admin", False),
        channel=context.channel,
        locale=context.locale,
    )
    return await services.feature_flags.get_public_snapshot(eval_ctx)


@router.get("/{feature_key}/decision")
async def get_feature_decision(
    feature_key: Annotated[str, Path(min_length=1, max_length=120)],
    services: ServicesDep,
    context: RequestContextDep,
) -> dict[str, object]:
    eval_ctx = EvaluationContext(
        user_id_hash=context.session.user_id_hash,
        authenticated=context.authenticated,
        is_admin=getattr(context.session, "is_admin", False),
        channel=context.channel,
        locale=context.locale,
    )
    decision = await services.feature_flags.evaluate(feature_key, eval_ctx)
    return {
        "key": decision.key,
        "enabled": decision.enabled,
        "reason": decision.reason.value,
        "lifecycle": decision.lifecycle.value,
        "requires_authentication": decision.requires_authentication,
    }


@router.post("/admin/{feature_key}", status_code=status.HTTP_200_OK)
async def update_feature_policy(
    feature_key: Annotated[str, Path(min_length=1, max_length=120)],
    payload: FeatureAdminUpdateRequest,
    services: ServicesDep,
    context: AdminRequestContextDep,
) -> dict[str, str]:
    if payload.policy.key != feature_key:
        return JSONResponse(status_code=400, content={"error": "Path key does not match payload key"})
    await services.feature_flags.update_policy(payload.policy)
    return {"status": "updated", "key": feature_key}
