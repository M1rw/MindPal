from __future__ import annotations

from datetime import UTC, datetime
import json

import httpx
import pytest

from backend.core.config import Settings
from backend.core.errors import AuthError, ProviderError, ProviderTimeoutError
from backend.models.feature_flags import FeatureContext, FeatureEvaluation, FeatureLifecycle, FeatureReason
from backend.models.voice_v4_layer0 import VOICE_V4_FEATURE_KEY
from backend.services.voice_v4_token_service import VoiceV4TokenService


def _feature(*, enabled: bool = True, lifecycle: FeatureLifecycle = FeatureLifecycle.PREVIEW) -> FeatureEvaluation:
    return FeatureEvaluation(
        key=VOICE_V4_FEATURE_KEY,
        title="Live voice",
        description="Preview",
        lifecycle=lifecycle,
        enabled=enabled,
        reason=FeatureReason.ENABLED if enabled else FeatureReason.DISABLED,
        user_visible=True,
        user_toggleable=False,
        safety_critical=False,
        version=1,
    )


def _context(*, authenticated: bool = True) -> FeatureContext:
    return FeatureContext(
        user_id_hash="usr_0123456789abcdef0123456789abcdef",
        authenticated=authenticated,
        channel="web",
        locale="en",
        now_utc=datetime(2026, 8, 27, tzinfo=UTC),
    )


def _settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "ENVIRONMENT": "staging",
        "VOICE_V4_PREVIEW_APPROVED": True,
        "GEMINI_API_KEY": "server-only-secret",
        "VOICE_V4_TOKEN_ENDPOINT": "https://provider.invalid/v1beta/auth_tokens",
        "VOICE_V4_TOKEN_TTL_SECONDS": 900,
        "VOICE_V4_NEW_SESSION_TTL_SECONDS": 60,
    }
    values.update(overrides)
    return Settings(**values)


@pytest.mark.asyncio
async def test_token_request_uses_exact_constraints_and_returns_narrow_grant() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"name": "auth_tokens/ephemeral-token"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        service = VoiceV4TokenService(settings=_settings(), client=client)
        grant = await service.issue_token(
            feature=_feature(),
            feature_context=_context(),
            request_id="request-voice-layer1",
        )

    assert len(requests) == 1
    request = requests[0]
    assert request.headers["x-goog-api-key"] == "server-only-secret"
    assert "server-only-secret" not in str(request.url)
    body = json.loads(request.content)
    assert body["uses"] == 1
    assert "expireTime" in body
    assert "newSessionExpireTime" in body
    assert grant.token == "auth_tokens/ephemeral-token"
    assert grant.model == "models/gemini-3.1-flash-live-preview"
    assert grant.protocol_version == "v1beta"
    assert grant.request_id == "request-voice-layer1"
    assert (grant.expires_at_utc - grant.new_session_expires_at_utc).total_seconds() == 840


@pytest.mark.asyncio
async def test_token_service_never_calls_provider_when_identity_or_release_is_denied() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={"name": "should-not-be-issued"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        service = VoiceV4TokenService(settings=_settings(), client=client)
        with pytest.raises(AuthError) as missing_auth:
            await service.issue_token(feature=_feature(), feature_context=_context(authenticated=False), request_id="request-auth")
        with pytest.raises(ProviderError) as disabled:
            await service.issue_token(feature=_feature(enabled=False), feature_context=_context(), request_id="request-disabled")

    assert missing_auth.value.code == "voice_authentication_required"
    assert disabled.value.code == "voice_feature_disabled"
    assert calls == 0


@pytest.mark.asyncio
async def test_provider_timeout_is_redacted_and_invalid_response_is_rejected() -> None:
    def timeout_handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("secret provider body should not escape")

    async with httpx.AsyncClient(transport=httpx.MockTransport(timeout_handler)) as client:
        service = VoiceV4TokenService(settings=_settings(), client=client)
        with pytest.raises(ProviderTimeoutError) as timeout_error:
            await service.issue_token(feature=_feature(), feature_context=_context(), request_id="request-timeout")

    assert timeout_error.value.code == "voice_provider_timeout"
    assert "secret provider body" not in str(timeout_error.value)

    def invalid_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"not-json-provider-body")

    async with httpx.AsyncClient(transport=httpx.MockTransport(invalid_handler)) as client:
        service = VoiceV4TokenService(settings=_settings(), client=client)
        with pytest.raises(ProviderError) as invalid_error:
            await service.issue_token(feature=_feature(), feature_context=_context(), request_id="request-invalid")

    assert invalid_error.value.code == "voice_provider_invalid_response"
    assert "not-json-provider-body" not in str(invalid_error.value)


@pytest.mark.asyncio
async def test_provider_http_failure_does_not_expose_api_key_or_provider_body() -> None:
    def failure_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, content=b"private provider failure payload")

    async with httpx.AsyncClient(transport=httpx.MockTransport(failure_handler)) as client:
        service = VoiceV4TokenService(settings=_settings(), client=client)
        with pytest.raises(ProviderError) as error:
            await service.issue_token(feature=_feature(), feature_context=_context(), request_id="request-provider-failure")

    assert error.value.code == "voice_provider_unavailable"
    assert "private provider failure payload" not in str(error.value)
    assert "server-only-secret" not in str(error.value)


@pytest.mark.asyncio
async def test_invalid_provider_endpoint_fails_before_network() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={"name": "unexpected"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        service = VoiceV4TokenService(
            settings=_settings(VOICE_V4_TOKEN_ENDPOINT="http://127.0.0.1/private"),
            client=client,
        )
        with pytest.raises(ProviderError) as error:
            await service.issue_token(feature=_feature(), feature_context=_context(), request_id="request-invalid-endpoint")

    assert error.value.code == "voice_configuration_invalid"
    assert calls == 0


@pytest.mark.asyncio
async def test_token_route_uses_authenticated_context_and_returns_narrow_response() -> None:
    from types import SimpleNamespace

    from backend.api.dependencies import RequestContext
    from backend.api.voice_v4_router import issue_voice_v4_token
    from backend.models.user import UserChannel, UserSession

    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"name": "auth_tokens/route-token"})

    async def consume(**kwargs: object) -> None:
        return None

    async def is_admin(session: object) -> bool:
        return False

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        settings = _settings()
        from backend.services.db_service import DBService, InMemoryDBProvider
        from backend.services.feature_flags_service import FeatureFlagsService
        async def load_policy_state():
            return _policy_state()

        db = DBService(provider=InMemoryDBProvider(), settings=settings)
        services = SimpleNamespace(
            settings=settings,
            feature_flags=FeatureFlagsService(),
            feature_policies=SimpleNamespace(
                load=load_policy_state,
            ),
            rate_limits=SimpleNamespace(consume=consume),
            admin_authority=SimpleNamespace(is_admin=is_admin),
            voice_v4_tokens=VoiceV4TokenService(settings=settings, client=client),
            db=db,
        )
        context = RequestContext(
            request_id="request-route-layer1",
            locale="en",
            channel=UserChannel.WEB,
            session=UserSession(
                raw_user_id="trusted-user",
                user_id_hash="usr_0123456789abcdef0123456789abcdef",
                channel=UserChannel.WEB,
                locale="en",
                authenticated=True,
                metadata={"admin": False},
            ),
            client_ip_hash="client-hash",
        )
        response = await issue_voice_v4_token(services, context)

    assert response.token == "auth_tokens/route-token"
    assert response.request_id == "request-route-layer1"
    assert response.model == "models/gemini-3.1-flash-live-preview"
    assert set(response.model_dump()) == {
        "token",
        "expires_at_utc",
        "new_session_expires_at_utc",
        "model",
        "protocol_version",
        "request_id",
    }
    assert len(requests) == 1


def _policy_state():
    from backend.services.feature_policy_repository import FeaturePolicyState
    from backend.models.feature_flags import FeaturePolicy

    return FeaturePolicyState(
        revision=3,
        policies={
            VOICE_V4_FEATURE_KEY: FeaturePolicy(
                key=VOICE_V4_FEATURE_KEY,
                enabled=True,
                lifecycle=FeatureLifecycle.PREVIEW,
            )
        },
    )
