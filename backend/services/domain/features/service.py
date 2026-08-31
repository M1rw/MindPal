# backend/services/domain/features/service.py

from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from typing import Any

from backend.models.feature_flags import (
    FEATURE_REGISTRY,
    FeatureContext,
    FeatureEvaluation,
    FeatureLifecycle,
    FeaturePolicy,
    FeatureReason,
    FeatureSpec,
)


class FeatureFlagsService:
    """Evaluates features against context, default specs, and policy overrides."""

    def __init__(
        self,
        *,
        registry: dict[str, FeatureSpec] | None = None,
        policies: dict[str, FeaturePolicy] | None = None,
        registry_version: int = 1,
    ) -> None:
        self.registry = registry or FEATURE_REGISTRY
        self.policies = policies or {}
        self.registry_version = registry_version

    def evaluate(self, key: str, context: FeatureContext) -> FeatureEvaluation:
        spec = self.registry.get(key)
        if spec is None:
            return FeatureEvaluation(
                key=key,
                title="Unknown Feature",
                description="Unknown feature key",
                lifecycle=FeatureLifecycle.DISABLED,
                enabled=False,
                reason=FeatureReason.UNKNOWN_KEY,
                version=0,
            )

        policy = self.policies.get(key)
        version = policy.version if policy is not None else 0

        lifecycle = policy.lifecycle if policy and policy.lifecycle is not None else spec.lifecycle
        if lifecycle in {FeatureLifecycle.DISABLED, FeatureLifecycle.MAINTENANCE}:
            return self._result(
                spec,
                lifecycle=lifecycle,
                enabled=False,
                reason=self._lifecycle_reason(lifecycle),
                version=version,
            )

        if _requires_authentication(spec, policy) and not context.authenticated:
            return self._result(
                spec,
                lifecycle=lifecycle,
                enabled=False,
                reason=FeatureReason.AUTHENTICATION_REQUIRED,
                version=version,
            )

        deny_users = _list_override(policy, "deny_user_hashes", spec.deny_user_hashes)
        if context.user_id_hash and context.user_id_hash.lower() in deny_users:
            return self._result(
                spec,
                lifecycle=lifecycle,
                enabled=False,
                reason=FeatureReason.EXPLICIT_DENY,
                version=version,
            )

        deny_emails = _list_override(policy, "deny_email_hashes", spec.deny_email_hashes)
        if context.email_hash and context.email_hash.lower() in deny_emails:
            return self._result(
                spec,
                lifecycle=lifecycle,
                enabled=False,
                reason=FeatureReason.EXPLICIT_DENY,
                version=version,
            )

        if not _within_schedule(policy, context.now_utc):
            return self._result(
                spec,
                lifecycle=lifecycle,
                enabled=False,
                reason=FeatureReason.OUTSIDE_SCHEDULE,
                version=version,
            )

        allow_users = _list_override(policy, "allow_user_hashes", spec.allow_user_hashes)
        if context.user_id_hash and context.user_id_hash.lower() in allow_users:
            return self._result(
                spec,
                lifecycle=lifecycle,
                enabled=True,
                reason=FeatureReason.EXPLICIT_ALLOW,
                version=version,
            )

        allow_emails = _list_override(policy, "allow_email_hashes", spec.allow_email_hashes)
        if context.email_hash and context.email_hash.lower() in allow_emails:
            return self._result(
                spec,
                lifecycle=lifecycle,
                enabled=True,
                reason=FeatureReason.EXPLICIT_ALLOW,
                version=version,
            )

        if _allow_admins(spec, policy) and context.is_admin:
            return self._result(
                spec,
                lifecycle=lifecycle,
                enabled=True,
                reason=FeatureReason.ADMIN_OVERRIDE,
                version=version,
            )

        channels = _list_override(policy, "allowed_channels", spec.allowed_channels)
        if channels and context.channel.lower() not in channels:
            return self._result(
                spec,
                lifecycle=lifecycle,
                enabled=False,
                reason=FeatureReason.CHANNEL_NOT_ALLOWED,
                version=version,
            )

        locales = _list_override(policy, "allowed_locales", spec.allowed_locales)
        if locales and context.locale.lower() not in locales and "auto" not in locales:
            return self._result(
                spec,
                lifecycle=lifecycle,
                enabled=False,
                reason=FeatureReason.LOCALE_NOT_ALLOWED,
                version=version,
            )

        policy_enabled = policy.enabled if policy and policy.enabled is not None else None
        if policy_enabled is False:
            return self._result(
                spec,
                lifecycle=lifecycle,
                enabled=False,
                reason=FeatureReason.DISABLED,
                version=version,
            )

        rollout = policy.rollout_percentage if policy and policy.rollout_percentage is not None else spec.rollout_percentage
        if rollout is not None:
            if not context.user_id_hash:
                return self._result(
                    spec,
                    lifecycle=lifecycle,
                    enabled=False,
                    reason=FeatureReason.ROLLOUT_ANONYMOUS_EXCLUDED,
                    version=version,
                )
            bucket = _stable_bucket(spec.key, context.user_id_hash)
            if bucket >= rollout:
                return self._result(
                    spec,
                    lifecycle=lifecycle,
                    enabled=False,
                    reason=FeatureReason.ROLLOUT_EXCLUDED,
                    version=version,
                )
            return self._result(
                spec,
                lifecycle=lifecycle,
                enabled=True,
                reason=FeatureReason.ROLLOUT_INCLUDED,
                version=version,
            )

        enabled = policy_enabled if policy_enabled is not None else spec.default_enabled
        reason = FeatureReason.POLICY_OVERRIDE if policy_enabled is not None else FeatureReason.DEFAULT
        return self._result(
            spec,
            lifecycle=lifecycle,
            enabled=enabled,
            reason=reason,
            version=version,
        )

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
    if getattr(spec, "override_database", False):
        return spec.requires_authentication
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
