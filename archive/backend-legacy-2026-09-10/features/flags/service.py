# backend/features/flags/service.py

"""
Feature flag evaluation service.
"""

from __future__ import annotations

import hashlib
from typing import Any

from .repo import FeaturePolicyRepository, InMemoryFeaturePolicyRepository
from .schemas import (
    BUILTIN_FEATURES,
    EvaluationContext,
    FeatureDecision,
    FeatureLifecycle,
    FeaturePolicy,
    FeaturePublicItem,
    FeaturePublicSnapshot,
    FeatureReason,
    FeatureSpec,
    get_all_feature_specs,
    get_feature_spec,
)


class FeatureFlagsService:
    """Evaluates feature flags against static specs and dynamic policies."""

    def __init__(self, repo: FeaturePolicyRepository | None = None) -> None:
        self._repo = repo or InMemoryFeaturePolicyRepository()

    async def evaluate(self, key: str, context: EvaluationContext) -> FeatureDecision:
        spec = get_feature_spec(key)
        if spec is None:
            return FeatureDecision(
                key=key,
                enabled=False,
                reason=FeatureReason.UNKNOWN_FEATURE,
                lifecycle=FeatureLifecycle.DISABLED,
                requires_authentication=False,
            )

        policy = await self._repo.get_policy(key)
        lifecycle = policy.lifecycle if (policy and policy.lifecycle) else spec.lifecycle
        req_auth = policy.requires_authentication if (policy and policy.requires_authentication is not None) else spec.requires_authentication
        allow_admins = policy.allow_admins if (policy and policy.allow_admins is not None) else spec.allow_admins

        if context.is_admin and allow_admins:
            return FeatureDecision(
                key=key,
                enabled=True,
                reason=FeatureReason.ENABLED_FOR_ADMIN,
                lifecycle=lifecycle,
                requires_authentication=req_auth,
            )

        if lifecycle == FeatureLifecycle.DISABLED:
            return FeatureDecision(key=key, enabled=False, reason=FeatureReason.DISABLED, lifecycle=lifecycle, requires_authentication=req_auth)
        if lifecycle == FeatureLifecycle.MAINTENANCE:
            return FeatureDecision(key=key, enabled=False, reason=FeatureReason.MAINTENANCE, lifecycle=lifecycle, requires_authentication=req_auth)

        if req_auth and not context.authenticated:
            return FeatureDecision(key=key, enabled=False, reason=FeatureReason.REQUIRES_AUTHENTICATION, lifecycle=lifecycle, requires_authentication=req_auth)

        if policy:
            if context.user_id_hash and context.user_id_hash in policy.deny_user_hashes:
                return FeatureDecision(key=key, enabled=False, reason=FeatureReason.EXPLICIT_DENY, lifecycle=lifecycle, requires_authentication=req_auth)
            if context.user_id_hash and context.user_id_hash in policy.allow_user_hashes:
                return FeatureDecision(key=key, enabled=True, reason=FeatureReason.ENABLED, lifecycle=lifecycle, requires_authentication=req_auth)
            if policy.enabled is False:
                return FeatureDecision(key=key, enabled=False, reason=FeatureReason.DISABLED, lifecycle=lifecycle, requires_authentication=req_auth)
            if policy.rollout_percentage is not None and context.user_id_hash:
                bucket = _compute_bucket(key, context.user_id_hash)
                if bucket >= policy.rollout_percentage:
                    return FeatureDecision(key=key, enabled=False, reason=FeatureReason.NOT_IN_ROLLOUT, lifecycle=lifecycle, requires_authentication=req_auth)

        enabled = spec.default_enabled if not policy or policy.enabled is None else policy.enabled
        return FeatureDecision(
            key=key,
            enabled=enabled,
            reason=FeatureReason.ENABLED if enabled else FeatureReason.DISABLED,
            lifecycle=lifecycle,
            requires_authentication=req_auth,
        )

    async def get_public_snapshot(self, context: EvaluationContext) -> FeaturePublicSnapshot:
        items = []
        for spec in get_all_feature_specs():
            if not spec.user_visible:
                continue
            decision = await self.evaluate(spec.key, context)
            items.append(
                FeaturePublicItem(
                    key=spec.key,
                    title=spec.title,
                    description=spec.description,
                    enabled=decision.enabled,
                    lifecycle=decision.lifecycle,
                    requires_authentication=decision.requires_authentication,
                    user_toggleable=spec.user_toggleable,
                    fallback_key=spec.fallback_key,
                    replacement_key=spec.replacement_key,
                )
            )
        return FeaturePublicSnapshot(features=items, policy_version=1)

    async def update_policy(self, policy: FeaturePolicy) -> None:
        await self._repo.set_policy(policy)

    async def delete_policy(self, key: str) -> None:
        await self._repo.delete_policy(key)


def _compute_bucket(feature_key: str, user_hash: str) -> int:
    h = hashlib.sha256(f"{feature_key}:{user_hash}".encode()).hexdigest()
    return int(h[:8], 16) % 100
