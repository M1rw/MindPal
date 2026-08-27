"""Persistence boundary for server-owned feature policies."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from backend.models.feature_flags import FeaturePolicy
from backend.services.db_service import DBService


class FeaturePolicyConflictError(RuntimeError):
    """Raised when an admin writes against an older policy-store revision."""


@dataclass(frozen=True, slots=True)
class FeaturePolicyState:
    revision: int
    policies: dict[str, FeaturePolicy]


class FeaturePolicyStore(Protocol):
    async def load(self) -> FeaturePolicyState:
        ...

    async def upsert(self, policy: FeaturePolicy, *, expected_revision: int) -> FeaturePolicyState:
        ...

    async def patch(self, policy: FeaturePolicy, *, expected_revision: int) -> FeaturePolicyState:
        ...


class FeaturePolicyRepository:
    """Store all active policies in one versioned document.

    A single document keeps the first release simple and works with both the
    existing Firestore provider and the local in-memory provider. Updates are
    atomic and use an expected revision to prevent lost admin changes. The
    repository never logs or returns raw provider errors.
    """

    COLLECTION = "feature_policies"
    DOCUMENT_KEY = "current"

    def __init__(self, *, db: DBService) -> None:
        self.db = db

    async def load(self) -> FeaturePolicyState:
        payload = await self.db.provider.get_document(self.COLLECTION, self.DOCUMENT_KEY)
        if not payload:
            return FeaturePolicyState(revision=0, policies={})

        revision = payload.get("revision", 0)
        try:
            clean_revision = max(0, int(revision))
        except (TypeError, ValueError):
            clean_revision = 0

        policies: dict[str, FeaturePolicy] = {}
        raw_policies = payload.get("policies")
        if not isinstance(raw_policies, dict):
            return FeaturePolicyState(revision=clean_revision, policies={})

        for key, raw_policy in raw_policies.items():
            if not isinstance(raw_policy, dict):
                continue
            try:
                policy_payload = dict(raw_policy)
                policy_payload["key"] = key
                policy = FeaturePolicy.model_validate(policy_payload)
            except Exception:
                # A malformed policy must not take down the feature snapshot.
                # It is ignored and remains available for an admin repair.
                continue
            policies[policy.key] = policy

        return FeaturePolicyState(revision=clean_revision, policies=policies)

    async def upsert(self, policy: FeaturePolicy, *, expected_revision: int) -> FeaturePolicyState:
        clean_policy = FeaturePolicy.model_validate(policy)

        def updater(current: dict[str, Any]) -> dict[str, Any]:
            current_revision = _revision(current)
            if current_revision != expected_revision:
                raise FeaturePolicyConflictError("feature policy revision conflict")

            raw_policies = current.get("policies")
            policies = dict(raw_policies) if isinstance(raw_policies, dict) else {}
            policies[clean_policy.key] = clean_policy.model_dump(mode="json")
            return {
                "revision": current_revision + 1,
                "policies": policies,
            }

        updated = await self.db.provider.atomic_update_document(
            self.COLLECTION,
            self.DOCUMENT_KEY,
            updater,
        )
        return await self._state_from_payload(updated)

    async def patch(self, policy: FeaturePolicy, *, expected_revision: int) -> FeaturePolicyState:
        clean_policy = FeaturePolicy.model_validate(policy)

        def updater(current: dict[str, Any]) -> dict[str, Any]:
            current_revision = _revision(current)
            if current_revision != expected_revision:
                raise FeaturePolicyConflictError("feature policy revision conflict")

            raw_policies = current.get("policies")
            policies = dict(raw_policies) if isinstance(raw_policies, dict) else {}
            existing = dict(policies.get(clean_policy.key) or {})
            patch_values = clean_policy.model_dump(mode="json", exclude_unset=True)
            patch_values.pop("key", None)
            if "version" not in patch_values:
                patch_values["version"] = max(1, int(existing.get("version", 0)) + 1)
            existing.update(patch_values)
            policies[clean_policy.key] = existing
            return {
                "revision": current_revision + 1,
                "policies": policies,
            }

        updated = await self.db.provider.atomic_update_document(
            self.COLLECTION,
            self.DOCUMENT_KEY,
            updater,
        )
        return await self._state_from_payload(updated)

    async def remove(self, key: str, *, expected_revision: int) -> FeaturePolicyState:
        clean_key = str(key or "").strip().lower()

        def updater(current: dict[str, Any]) -> dict[str, Any]:
            current_revision = _revision(current)
            if current_revision != expected_revision:
                raise FeaturePolicyConflictError("feature policy revision conflict")

            raw_policies = current.get("policies")
            policies = dict(raw_policies) if isinstance(raw_policies, dict) else {}
            policies.pop(clean_key, None)
            return {
                "revision": current_revision + 1,
                "policies": policies,
            }

        updated = await self.db.provider.atomic_update_document(
            self.COLLECTION,
            self.DOCUMENT_KEY,
            updater,
        )
        return await self._state_from_payload(updated)

    async def _state_from_payload(self, payload: dict[str, Any]) -> FeaturePolicyState:
        # Reuse the same validation path as reads without making a second DB call.
        revision = _revision(payload)
        policies: dict[str, FeaturePolicy] = {}
        raw_policies = payload.get("policies")
        if isinstance(raw_policies, dict):
            for key, raw_policy in raw_policies.items():
                if not isinstance(raw_policy, dict):
                    continue
                try:
                    policy_payload = dict(raw_policy)
                    policy_payload["key"] = key
                    policy = FeaturePolicy.model_validate(policy_payload)
                except Exception:
                    continue
                policies[policy.key] = policy
        return FeaturePolicyState(revision=revision, policies=policies)


def _revision(payload: dict[str, Any]) -> int:
    try:
        return max(0, int(payload.get("revision", 0)))
    except (TypeError, ValueError):
        return 0
