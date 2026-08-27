import httpx
import pytest

from backend.core.errors import DatabaseError
from backend.models.feature_flags import FeaturePolicy
from backend.services.feature_policy_repository import FeaturePolicyConflictError
from backend.services.supabase_client import SupabaseClient
from backend.services.supabase_feature_policy_repository import SupabaseFeaturePolicyRepository


@pytest.fixture
def policy() -> FeaturePolicy:
    return FeaturePolicy(
        key="voice.live_v4",
        version=1,
        enabled=True,
        allow_admins=True,
        allow_user_hashes=["usr_0123456789abcdef0123456789abcdef"],
    )


@pytest.mark.asyncio
async def test_supabase_policy_store_reads_and_writes_through_postgrest(policy: FeaturePolicy) -> None:
    requests: list[httpx.Request] = []
    stored = {"key": "current", "revision": 0, "policies": {}}

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "GET":
            return httpx.Response(200, json=[stored])
        payload = request.read()
        assert b"mindpal_feature_policies" not in payload
        return httpx.Response(
            200,
            json={"ok": True, "revision": 1, "policies": {policy.key: policy.model_dump(mode="json")}},
        )

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as http_client:
        client = SupabaseClient(
            base_url="https://example.supabase.co",
            service_role_key="server-only-key",
            http_client=http_client,
        )
        repository = SupabaseFeaturePolicyRepository(client=client)
        loaded = await repository.load()
        updated = await repository.upsert(policy, expected_revision=loaded.revision)

    assert loaded.revision == 0
    assert updated.revision == 1
    assert updated.policies[policy.key].enabled is True
    assert requests[0].url.path == "/rest/v1/mindpal_feature_policies"
    assert requests[2].url.path == "/rest/v1/rpc/mindpal_update_feature_policies"
    assert requests[2].headers["authorization"] == "Bearer server-only-key"


@pytest.mark.asyncio
async def test_supabase_policy_store_rejects_stale_revision(policy: FeaturePolicy) -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json=[{"key": "current", "revision": 2, "policies": {}}])
        return httpx.Response(200, json={"ok": False, "revision": 2, "policies": {}})

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as http_client:
        client = SupabaseClient(
            base_url="https://example.supabase.co",
            service_role_key="server-only-key",
            http_client=http_client,
        )
        repository = SupabaseFeaturePolicyRepository(client=client)
        with pytest.raises(FeaturePolicyConflictError):
            await repository.patch(policy, expected_revision=1)


@pytest.mark.asyncio
async def test_supabase_client_redacts_provider_error_details() -> None:
    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"message": "secret provider response"})

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as http_client:
        client = SupabaseClient(
            base_url="https://example.supabase.co",
            service_role_key="server-only-key",
            http_client=http_client,
        )
        with pytest.raises(DatabaseError) as caught:
            await client.request("GET", "/rest/v1/mindpal_feature_policies")

    assert "server-only-key" not in str(caught.value)
    assert "secret provider response" not in str(caught.value)
