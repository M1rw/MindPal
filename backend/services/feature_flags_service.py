"""Pure feature-policy evaluation for MindPal.

The evaluator has no network or database side effects. A repository can load
validated policy documents and pass them in; tests and local callers can use the
built-in registry directly. The same precedence must be used for every backend
operation and for the public feature snapshot.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

from backend.models.feature_flags import (
    FEATURE_REGISTRY,
    REGISTRY_VERSION,
    FeatureContext,
    FeatureEvaluation,
    FeatureLifecycle,
    FeaturePolicy,
    FeatureReason,
    FeatureSpec,
)


class FeatureFlagsService:
    """Evaluate registered features against trusted request context."""

    def __init__(
        self,
        *,
        registry: Mapping[str, FeatureSpec] | None = None,
        policies: Mapping[str, FeaturePolicy] | None = None,
        registry_version: int = REGISTRY_VERSION,
    ) -> None:
        self.registry = dict(registry or FEATURE_REGISTRY)
        self.policies = dict(policies or {})
        self.registry_version = int(registry_version)

    def evaluate(self, key: str, context: FeatureContext) -> FeatureEvaluation:
        return self._evaluate(key, context, seen=frozenset())

    def _evaluate(self, key: str, context: FeatureContext, *, seen: frozenset[str]) -> FeatureEvaluation:
        normalized_key = str(key or "").strip().lower()
        spec = self.registry.get(normalized_key)
        if spec is None:
            return FeatureEvaluation(
                key=normalized_key or "unknown",
                title="Unavailable feature",
                description="This feature is not available in the current release.",
                lifecycle=FeatureLifecycle.DISABLED,
                enabled=False,
                reason=FeatureReason.UNKNOWN_FEATURE,
                user_visible=False,
                user_toggleable=False,
                safety_critical=False,
                version=self.registry_version,
            )

        policy = self.policies.get(normalized_key)
        lifecycle = policy.lifecycle if policy and policy.lifecycle is not None else spec.lifecycle
        if normalized_key in seen:
            return self._result(
                spec,
                lifecycle=lifecycle,
                enabled=False,
                reason=FeatureReason.PREREQUISITE_DISABLED,
                version=policy.version if policy else self.registry_version,
            )
        enabled = spec.default_enabled
        reason = FeatureReason.ENABLED if enabled else FeatureReason.DISABLED
        version = policy.version if policy else self.registry_version

        # Safety-critical controls are intentionally not user-disableable. Their
        # implementation can still fail independently, but policy evaluation
        # never turns the control off.
        if spec.safety_critical:
            return self._result(
                spec,
                lifecycle=FeatureLifecycle.ACTIVE,
                enabled=True,
                reason=FeatureReason.ENABLED,
                version=version,
            )

        if policy is not None and policy.enabled is False:
            return self._result(spec, lifecycle=lifecycle, enabled=False, reason=self._lifecycle_reason(lifecycle), version=version)

        if lifecycle in {FeatureLifecycle.MAINTENANCE, FeatureLifecycle.DISABLED}:
            return self._result(spec, lifecycle=lifecycle, enabled=False, reason=self._lifecycle_reason(lifecycle), version=version)

        if not _within_schedule(policy, context.now_utc):
            if policy and policy.starts_at_utc and context.now_utc < policy.starts_at_utc:
                reason = FeatureReason.NOT_STARTED
            else:
                reason = FeatureReason.EXPIRED
            return self._result(spec, lifecycle=lifecycle, enabled=False, reason=reason, version=version)

        if _requires_authentication(spec, policy) and not context.authenticated:
            return self._result(spec, lifecycle=lifecycle, enabled=False, reason=FeatureReason.REQUIRES_AUTHENTICATION, version=version)

        if policy and context.authenticated and context.user_id_hash:
            if context.user_id_hash in set(policy.deny_user_hashes):
                return self._result(spec, lifecycle=lifecycle, enabled=False, reason=FeatureReason.EXPLICIT_DENY, version=version)
            if context.user_id_hash in set(policy.allow_user_hashes):
                return self._result(spec, lifecycle=lifecycle, enabled=True, reason=FeatureReason.ENABLED, version=version)

        if context.is_admin and _allow_admins(spec, policy):
            return self._result(spec, lifecycle=lifecycle, enabled=True, reason=FeatureReason.ENABLED_FOR_ADMIN, version=version)

        allowed_channels = _list_override(policy, "allowed_channels", spec.allowed_channels)
        if allowed_channels and context.channel not in allowed_channels:
            return self._result(spec, lifecycle=lifecycle, enabled=False, reason=FeatureReason.CHANNEL_NOT_ALLOWED, version=version)

        allowed_locales = _list_override(policy, "allowed_locales", spec.allowed_locales)
        if allowed_locales and context.locale not in allowed_locales:
            return self._result(spec, lifecycle=lifecycle, enabled=False, reason=FeatureReason.LOCALE_NOT_ALLOWED, version=version)

        prerequisites = _list_override(policy, "prerequisites", spec.prerequisites)
        for prerequisite in prerequisites:
            prerequisite_result = self._evaluate(prerequisite, context, seen=seen | {normalized_key})
            if not prerequisite_result.enabled:
                return self._result(
                    spec,
                    lifecycle=lifecycle,
                    enabled=False,
                    reason=FeatureReason.PREREQUISITE_DISABLED,
                    version=version,
                )

        rollout_percentage = policy.rollout_percentage if policy and policy.rollout_percentage is not None else 100
        if rollout_percentage < 100:
            if not context.authenticated or not context.user_id_hash:
                return self._result(spec, lifecycle=lifecycle, enabled=False, reason=FeatureReason.PREVIEW_ONLY, version=version)
            if _stable_bucket(normalized_key, context.user_id_hash) >= rollout_percentage:
                return self._result(spec, lifecycle=lifecycle, enabled=False, reason=FeatureReason.NOT_IN_ROLLOUT, version=version)

        if policy and policy.enabled is True:
            enabled = True
        elif policy is not None and policy.enabled is None:
            enabled = spec.default_enabled
        elif policy is None:
            enabled = spec.default_enabled

        if lifecycle == FeatureLifecycle.PREVIEW and not policy:
            enabled = False
            reason = FeatureReason.PREVIEW_ONLY
        elif enabled:
            reason = FeatureReason.ENABLED
        else:
            reason = FeatureReason.DISABLED

        return self._result(spec, lifecycle=lifecycle, enabled=enabled, reason=reason, version=version)

    def evaluate_all(self, context: FeatureContext) -> list[FeatureEvaluation]:
        return [self.evaluate(key, context) for key in sorted(self.registry)]

    def is_enabled(self, key: str, context: FeatureContext) -> bool:
        return self.evaluate(key, context).enabled

    def _result(
        self,
        spec: FeatureSpec,
        *,
        lifecycle: FeatureLifecycle,
        enabled: bool,
        reason: FeatureReason,
        version: int,
    ) -> FeatureEvaluation:
        return FeatureEvaluation(
            key=spec.key,
            title=spec.title,
            description=spec.description,
            lifecycle=lifecycle,
            enabled=bool(enabled),
            reason=reason,
            user_visible=spec.user_visible,
            user_toggleable=spec.user_toggleable and not spec.safety_critical,
            safety_critical=spec.safety_critical,
            fallback_key=spec.fallback_key,
            replacement_key=spec.replacement_key,
            version=version,
        )

    @staticmethod
    def _lifecycle_reason(lifecycle: FeatureLifecycle) -> FeatureReason:
        if lifecycle == FeatureLifecycle.MAINTENANCE:
            return FeatureReason.MAINTENANCE
        return FeatureReason.DISABLED


def _requires_authentication(spec: FeatureSpec, policy: FeaturePolicy | None) -> bool:
    return policy.requires_authentication if policy and policy.requires_authentication is not None else spec.requires_authentication


def _allow_admins(spec: FeatureSpec, policy: FeaturePolicy | None) -> bool:
    return policy.allow_admins if policy and policy.allow_admins is not None else spec.allow_admins


def _list_override(policy: FeaturePolicy | None, name: str, default: Any) -> set[str]:
    value = getattr(policy, name, None) if policy is not None else None
    if value is None:
        return set(default)
    return {str(item).strip().lower() for item in value if str(item).strip()}


def _within_schedule(policy: FeaturePolicy | None, now_utc: datetime) -> bool:
    if policy is None:
        return True
    now = now_utc.astimezone(UTC)
    if policy.starts_at_utc is not None and now < policy.starts_at_utc:
        return False
    if policy.ends_at_utc is not None and now >= policy.ends_at_utc:
        return False
    return True


def _stable_bucket(feature_key: str, user_id_hash: str) -> int:
    digest = hashlib.sha256(f"{feature_key}:{user_id_hash}".encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") % 100
