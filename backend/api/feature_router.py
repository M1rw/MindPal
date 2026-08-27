from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.api.dependencies import (
    AdminRequestContextDep,
    ChannelDep,
    LocaleDep,
    ServicesDep,
    assert_authenticated,
)
from backend.models.feature_flags import (
    FEATURE_REGISTRY,
    FeatureContext,
    FeatureLifecycle,
    FeaturePolicy,
)
from backend.core.security import hash_user_id, sanitize_text
from backend.services.auth_service import parse_bearer_token
from backend.services.feature_flags_service import FeatureFlagsService
from backend.services.feature_policy_repository import FeaturePolicyConflictError


router = APIRouter(prefix="/api/features", tags=["features"])
admin_router = APIRouter(prefix="/api/admin/features", tags=["feature-admin"])


class FeatureSnapshotResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    registry_version: int = Field(ge=1)
    policy_revision: int = Field(ge=0)
    stale: bool = False
    features: list[dict[str, object]]


class AdminFeatureSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: str
    title: str
    description: str
    lifecycle: FeatureLifecycle
    default_enabled: bool
    policy_enabled: bool | None
    rollout_percentage: int | None
    requires_authentication: bool
    allow_admins: bool
    allow_user_count: int
    deny_user_count: int
    policy_version: int


class AdminFeatureListResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    registry_version: int
    policy_revision: int
    features: list[AdminFeatureSummary]


class AdminFeaturePolicyPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_revision: int = Field(ge=0)
    policy: FeaturePolicy
    allow_user_ids: list[str] | None = Field(default=None, max_length=1_000)
    deny_user_ids: list[str] | None = Field(default=None, max_length=1_000)

    @field_validator("allow_user_ids", "deny_user_ids", mode="before")
    @classmethod
    def _clean_target_ids(cls, value: object) -> list[str] | None:
        if value is None:
            return None
        if not isinstance(value, (list, tuple, set, frozenset)):
            raise ValueError("user IDs must be a list")
        cleaned = [sanitize_text(str(item), 160) for item in value]
        return list(dict.fromkeys(item for item in cleaned if item))


class AdminFeaturePolicyResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    registry_version: int
    policy_revision: int
    feature: AdminFeatureSummary


async def get_optional_feature_context(
    services: ServicesDep,
    locale: LocaleDep,
    channel: ChannelDep,
    authorization: Annotated[str | None, Header(alias="Authorization")] = None,
    x_firebase_app_check: Annotated[str | None, Header(alias="X-Firebase-AppCheck")] = None,
) -> FeatureContext:
    """Resolve trusted identity when supplied, otherwise use safe anonymous context."""
    if not parse_bearer_token(authorization):
        return FeatureContext(
            authenticated=False,
            channel=channel.value,
            locale=locale,
        )

    session = await services.auth.resolve_session(
        authorization_header=authorization,
        raw_user_id=None,
        channel=channel,
        locale=locale,
        require_auth=True,
    )
    if services.settings.REQUIRE_FIREBASE_APP_CHECK:
        await services.auth.verify_app_check_token(x_firebase_app_check)

    return FeatureContext(
        user_id_hash=session.user_id_hash,
        authenticated=session.authenticated,
        is_admin=await services.admin_authority.is_admin(session),
        channel=session.channel.value,
        locale=session.locale,
    )


FeatureContextDep = Annotated[FeatureContext, Depends(get_optional_feature_context)]


@router.get("", response_model=FeatureSnapshotResponse)
async def feature_snapshot(
    services: ServicesDep,
    feature_context: FeatureContextDep,
) -> FeatureSnapshotResponse:
    state = await services.feature_policies.load()
    evaluator = FeatureFlagsService(
        registry=services.feature_flags.registry,
        policies=state.policies,
        registry_version=services.feature_flags.registry_version,
    )
    evaluations = evaluator.evaluate_all(feature_context)
    return FeatureSnapshotResponse(
        registry_version=evaluator.registry_version,
        policy_revision=state.revision,
        features=[evaluation.to_public_dict() for evaluation in evaluations if evaluation.user_visible],
    )


@admin_router.get("", response_model=AdminFeatureListResponse)
async def admin_feature_list(
    services: ServicesDep,
    context: AdminRequestContextDep,
) -> AdminFeatureListResponse:
    assert_authenticated(context)
    state = await services.feature_policies.load()
    return AdminFeatureListResponse(
        registry_version=services.feature_flags.registry_version,
        policy_revision=state.revision,
        features=[_admin_summary(key, state.policies.get(key)) for key in sorted(FEATURE_REGISTRY)],
    )


@admin_router.patch("/{feature_key}", response_model=AdminFeaturePolicyResponse)
async def admin_feature_patch(
    feature_key: str,
    payload: AdminFeaturePolicyPayload,
    services: ServicesDep,
    context: AdminRequestContextDep,
) -> AdminFeaturePolicyResponse:
    assert_authenticated(context)
    key = feature_key.strip().lower()
    spec = FEATURE_REGISTRY.get(key)
    if spec is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "unknown_feature", "message": "Feature is not registered"},
        )
    if payload.policy.key != key:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "feature_key_mismatch", "message": "Policy key must match the route"},
        )
    policy = _policy_with_target_ids(payload.policy, payload.allow_user_ids, payload.deny_user_ids)
    if spec.safety_critical and (
        policy.enabled is False
        or policy.lifecycle in {FeatureLifecycle.MAINTENANCE, FeatureLifecycle.DISABLED}
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "safety_critical_feature",
                "message": "Safety-critical features cannot be disabled by feature policy",
            },
        )

    try:
        state = await services.feature_policies.patch(
            policy,
            expected_revision=payload.expected_revision,
        )
    except FeaturePolicyConflictError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "feature_policy_conflict", "message": "Feature policy changed; reload before saving"},
        ) from exc

    return AdminFeaturePolicyResponse(
        registry_version=services.feature_flags.registry_version,
        policy_revision=state.revision,
        feature=_admin_summary(key, state.policies.get(key)),
    )


@admin_router.put("/{feature_key}", response_model=AdminFeaturePolicyResponse)
async def admin_feature_update(
    feature_key: str,
    payload: AdminFeaturePolicyPayload,
    services: ServicesDep,
    context: AdminRequestContextDep,
) -> AdminFeaturePolicyResponse:
    assert_authenticated(context)
    key = feature_key.strip().lower()
    spec = FEATURE_REGISTRY.get(key)
    if spec is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "unknown_feature", "message": "Feature is not registered"},
        )
    if payload.policy.key != key:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "feature_key_mismatch", "message": "Policy key must match the route"},
        )
    policy = _policy_with_target_ids(payload.policy, payload.allow_user_ids, payload.deny_user_ids)
    if spec.safety_critical and (
        policy.enabled is False
        or policy.lifecycle in {FeatureLifecycle.MAINTENANCE, FeatureLifecycle.DISABLED}
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "safety_critical_feature",
                "message": "Safety-critical features cannot be disabled by feature policy",
            },
        )

    try:
        state = await services.feature_policies.upsert(
            policy,
            expected_revision=payload.expected_revision,
        )
    except FeaturePolicyConflictError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "feature_policy_conflict", "message": "Feature policy changed; reload before saving"},
        ) from exc

    return AdminFeaturePolicyResponse(
        registry_version=services.feature_flags.registry_version,
        policy_revision=state.revision,
        feature=_admin_summary(key, state.policies.get(key)),
    )


def _policy_with_target_ids(
    policy: FeaturePolicy,
    allow_user_ids: list[str] | None,
    deny_user_ids: list[str] | None,
) -> FeaturePolicy:
    updates: dict[str, object] = {}
    if allow_user_ids is not None:
        updates["allow_user_hashes"] = [hash_user_id(f"firebase:{user_id}") for user_id in allow_user_ids]
    if deny_user_ids is not None:
        updates["deny_user_hashes"] = [hash_user_id(f"firebase:{user_id}") for user_id in deny_user_ids]
    return policy.model_copy(update=updates) if updates else policy


def _admin_summary(key: str, policy: FeaturePolicy | None) -> AdminFeatureSummary:
    spec = FEATURE_REGISTRY[key]
    return AdminFeatureSummary(
        key=key,
        title=spec.title,
        description=spec.description,
        lifecycle=policy.lifecycle if policy and policy.lifecycle is not None else spec.lifecycle,
        default_enabled=spec.default_enabled,
        policy_enabled=policy.enabled if policy else None,
        rollout_percentage=policy.rollout_percentage if policy else None,
        requires_authentication=(
            policy.requires_authentication
            if policy and policy.requires_authentication is not None
            else spec.requires_authentication
        ),
        allow_admins=(policy.allow_admins if policy and policy.allow_admins is not None else spec.allow_admins),
        allow_user_count=len(policy.allow_user_hashes) if policy else 0,
        deny_user_count=len(policy.deny_user_hashes) if policy else 0,
        policy_version=policy.version if policy else 0,
    )
