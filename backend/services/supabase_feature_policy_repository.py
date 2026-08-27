from __future__ import annotations

from typing import Any

from backend.models.feature_flags import FeaturePolicy
from backend.services.feature_policy_repository import (
    FeaturePolicyConflictError,
    FeaturePolicyState,
)
from backend.services.supabase_client import SupabaseClient


POLICY_TABLE = "mindpal_feature_policies"
POLICY_KEY = "current"


class SupabaseFeaturePolicyRepository:
    """Versioned feature-policy store backed by Supabase PostgREST.

    Firebase Auth remains authoritative for identity and admin claims. The
    Supabase table is selected only by explicit backend configuration.
    """

    def __init__(self, *, client: SupabaseClient) -> None:
        self.client = client

    async def load(self) -> FeaturePolicyState:
        response = await self.client.request(
            "GET",
            f"/rest/v1/{POLICY_TABLE}",
            params={"key": f"eq.{POLICY_KEY}", "select": "key,revision,policies"},
        )
        rows = self.client.decode_json(response)
        if not isinstance(rows, list) or not rows:
            return FeaturePolicyState(revision=0, policies={})
        return _state_from_row(rows[0])

    async def upsert(self, policy: FeaturePolicy, *, expected_revision: int) -> FeaturePolicyState:
        current = await self.load()
        if current.revision != expected_revision:
            raise FeaturePolicyConflictError("feature policy revision conflict")
        policies = dict(_dump_policies(current.policies))
        policies[policy.key] = policy.model_dump(mode="json")
        return await self._write(expected_revision, policies)

    async def patch(self, policy: FeaturePolicy, *, expected_revision: int) -> FeaturePolicyState:
        current = await self.load()
        if current.revision != expected_revision:
            raise FeaturePolicyConflictError("feature policy revision conflict")
        policies = dict(_dump_policies(current.policies))
        existing = dict(policies.get(policy.key) or {})
        patch_values = policy.model_dump(mode="json", exclude_unset=True)
        patch_values.pop("key", None)
        patch_values.setdefault("version", max(1, int(existing.get("version", 0)) + 1))
        existing.update(patch_values)
        policies[policy.key] = existing
        return await self._write(expected_revision, policies)

    async def _write(self, expected_revision: int, policies: dict[str, Any]) -> FeaturePolicyState:
        response = await self.client.request(
            "POST",
            "/rest/v1/rpc/mindpal_update_feature_policies",
            payload={"expected_revision": expected_revision, "next_policies": policies},
        )
        result = self.client.decode_json(response)
        if not isinstance(result, dict):
            raise RuntimeError("Supabase policy write returned an invalid result")
        if result.get("ok") is not True:
            raise FeaturePolicyConflictError("feature policy revision conflict")
        return _state_from_row(result)


def _state_from_row(row: object) -> FeaturePolicyState:
    if not isinstance(row, dict):
        return FeaturePolicyState(revision=0, policies={})
    try:
        revision = max(0, int(row.get("revision", 0)))
    except (TypeError, ValueError):
        revision = 0

    raw_policies = row.get("policies")
    policies: dict[str, FeaturePolicy] = {}
    if not isinstance(raw_policies, dict):
        return FeaturePolicyState(revision=revision, policies=policies)

    for key, raw_policy in raw_policies.items():
        if not isinstance(raw_policy, dict):
            continue
        try:
            payload = dict(raw_policy)
            payload["key"] = key
            parsed = FeaturePolicy.model_validate(payload)
        except Exception:
            continue
        policies[parsed.key] = parsed
    return FeaturePolicyState(revision=revision, policies=policies)


def _dump_policies(policies: dict[str, FeaturePolicy]) -> dict[str, dict[str, Any]]:
    return {key: policy.model_dump(mode="json") for key, policy in policies.items()}
