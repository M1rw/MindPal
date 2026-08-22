from __future__ import annotations

from types import SimpleNamespace
import importlib

import pytest
from fastapi import HTTPException, Response
from pydantic import SecretStr

voice_router = importlib.import_module("backend.api.voice_router")
from backend.services.idempotency_service import IdempotencyClaim
from backend.services.quota_service import QuotaSnapshot


def context() -> SimpleNamespace:
    return SimpleNamespace(
        request_id="fallback-resilience-request",
        locale="en",
        session=SimpleNamespace(authenticated=True, user_id_hash="fallback-user"),
    )


class RecordingRateLimits:
    async def consume(self, **_: object) -> None:
        return None


class RecordingIdempotency:
    def __init__(self) -> None:
        self.claim_count = 0
        self.complete_count = 0
        self.fail_count = 0

    @staticmethod
    def payload_hash(payload: object) -> str:
        return repr(payload)

    async def claim(self, **_: object) -> IdempotencyClaim:
        self.claim_count += 1
        return IdempotencyClaim(key="fallback-claim", owner=True, completed=False)

    async def complete(self, **_: object) -> None:
        self.complete_count += 1

    async def fail(self, **_: object) -> None:
        self.fail_count += 1


class RecordingQuota:
    def __init__(self) -> None:
        self.reserve_count = 0
        self.commit_count = 0
        self.refund_count = 0

    async def reserve(self, **_: object) -> None:
        self.reserve_count += 1

    async def commit(self, **_: object) -> QuotaSnapshot:
        self.commit_count += 1
        return QuotaSnapshot(1, 50, 100, 1, 500, 1000, 1)

    async def refund(self, **_: object) -> QuotaSnapshot:
        self.refund_count += 1
        return QuotaSnapshot(0, 50, 100, 0, 500, 1000, 0)


def services(primary: str, fallback: str) -> SimpleNamespace:
    return SimpleNamespace(
        settings=SimpleNamespace(
            GEMINI_API_KEY=SecretStr("test-provider-secret"),
            GEMINI_LIVE_MODEL=primary,
            GEMINI_LIVE_FALLBACK_MODEL=fallback,
            VOICE_TOKEN_TTL_SECONDS=1800,
            VOICE_NEW_SESSION_TTL_SECONDS=60,
            VOICE_TOKEN_RATE_LIMIT_PER_HOUR=16,
            VOICE_SESSION_QUOTA_COST=1,
        ),
        rate_limits=RecordingRateLimits(),
        idempotency=RecordingIdempotency(),
        quota=RecordingQuota(),
    )


@pytest.mark.asyncio
async def test_primary_success_does_not_probe_or_charge_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, str]] = []

    async def create(**kwargs: object) -> str:
        calls.append((str(kwargs["model"]), str(kwargs["api_version"])))
        return "primary-token"

    service = services("gemini-3.1-flash-live-preview", "gemini-2.5-flash-native-audio-preview-12-2025")
    monkeypatch.setattr(voice_router, "_create_ephemeral_voice_token", create)

    result = await voice_router.get_voice_token(Response(), service, context())

    assert calls == [("gemini-3.1-flash-live-preview", "v1beta")]
    assert result.model == "gemini-3.1-flash-live-preview"
    assert service.quota.reserve_count == 1
    assert service.quota.commit_count == 1
    assert service.quota.refund_count == 0
    assert service.idempotency.complete_count == 1
    assert service.idempotency.fail_count == 0


@pytest.mark.asyncio
async def test_primary_31_failure_falls_back_once_to_25_and_commits_once(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, str]] = []

    async def create(**kwargs: object) -> str:
        calls.append((str(kwargs["model"]), str(kwargs["api_version"])))
        if len(calls) == 1:
            raise RuntimeError("3.1 provisioning unavailable")
        return "fallback-25-token"

    service = services("gemini-3.1-flash-live-preview", "gemini-2.5-flash-native-audio-preview-12-2025")
    monkeypatch.setattr(voice_router, "_create_ephemeral_voice_token", create)

    result = await voice_router.get_voice_token(Response(), service, context())

    assert calls == [
        ("gemini-3.1-flash-live-preview", "v1beta"),
        ("gemini-2.5-flash-native-audio-preview-12-2025", "v1beta"),
    ]
    assert result.model == "gemini-2.5-flash-native-audio-preview-12-2025"
    assert "v1beta.GenerativeService.BidiGenerateContentConstrained" in result.websocket_url
    assert service.quota.reserve_count == 1
    assert service.quota.commit_count == 1
    assert service.quota.refund_count == 0
    assert service.idempotency.complete_count == 1
    assert service.idempotency.fail_count == 0


@pytest.mark.asyncio
async def test_same_primary_and_fallback_is_attempted_once(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    async def create(**kwargs: object) -> str:
        calls.append(str(kwargs["model"]))
        raise RuntimeError("model unavailable")

    service = services("gemini-2.5-flash-native-audio-preview-12-2025", "gemini-2.5-flash-native-audio-preview-12-2025")
    monkeypatch.setattr(voice_router, "_create_ephemeral_voice_token", create)

    with pytest.raises(HTTPException) as error:
        await voice_router.get_voice_token(Response(), service, context())

    assert error.value.status_code == 502
    assert calls == ["gemini-2.5-flash-native-audio-preview-12-2025"]
    assert service.quota.reserve_count == 1
    assert service.quota.commit_count == 0
    assert service.quota.refund_count == 1
    assert service.idempotency.complete_count == 0
    assert service.idempotency.fail_count == 1


@pytest.mark.asyncio
async def test_dual_failure_refunds_once_and_does_not_return_partial_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, str]] = []

    async def create(**kwargs: object) -> str:
        calls.append((str(kwargs["model"]), str(kwargs["api_version"])))
        raise RuntimeError(f"{kwargs['model']} unavailable")

    service = services("gemini-3.1-flash-live-preview", "gemini-2.5-flash-native-audio-preview-12-2025")
    monkeypatch.setattr(voice_router, "_create_ephemeral_voice_token", create)

    with pytest.raises(HTTPException) as error:
        await voice_router.get_voice_token(Response(), service, context())

    assert error.value.status_code == 502
    assert calls == [
        ("gemini-3.1-flash-live-preview", "v1beta"),
        ("gemini-2.5-flash-native-audio-preview-12-2025", "v1beta"),
    ]
    assert service.quota.reserve_count == 1
    assert service.quota.commit_count == 0
    assert service.quota.refund_count == 1
    assert service.idempotency.complete_count == 0
    assert service.idempotency.fail_count == 1


@pytest.mark.asyncio
async def test_fallback_success_preserves_model_identity_for_frontend_setup(monkeypatch: pytest.MonkeyPatch) -> None:
    async def create(**kwargs: object) -> str:
        if kwargs["model"] == "gemini-3.1-flash-live-preview":
            raise RuntimeError("primary unavailable")
        return "native-fallback-token"

    service = services("gemini-3.1-flash-live-preview", "gemini-2.5-flash-native-audio-preview-12-2025")
    monkeypatch.setattr(voice_router, "_create_ephemeral_voice_token", create)

    result = await voice_router.get_voice_token(Response(), service, context())

    assert result.model == "gemini-2.5-flash-native-audio-preview-12-2025"
    assert result.websocket_url.endswith("v1beta.GenerativeService.BidiGenerateContentConstrained")


@pytest.mark.asyncio
async def test_primary_31_issues_signed_grant_and_fallback_reuses_no_quota(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    async def create(**kwargs: object) -> str:
        calls.append(str(kwargs["model"]))
        return f"token-{len(calls)}"

    service = services("gemini-3.1-flash-live-preview", "gemini-2.5-flash-native-audio-preview-12-2025")
    monkeypatch.setattr(voice_router, "_create_ephemeral_voice_token", create)

    primary = await voice_router.get_voice_token(Response(), service, context())
    assert primary.fallback_grant
    assert primary.fallback_used is False
    assert primary.model == "gemini-3.1-flash-live-preview"

    fallback = await voice_router.get_voice_token(Response(), service, context(), fallback_grant=primary.fallback_grant)

    assert fallback.model == "gemini-2.5-flash-native-audio-preview-12-2025"
    assert fallback.fallback_used is True
    assert fallback.usage is None
    assert fallback.fallback_grant is None
    assert calls == ["gemini-3.1-flash-live-preview", "gemini-2.5-flash-native-audio-preview-12-2025"]
    assert service.quota.reserve_count == 1
    assert service.quota.commit_count == 1
    assert service.quota.refund_count == 0


@pytest.mark.asyncio
async def test_invalid_fallback_grant_is_rejected_before_provider_call(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    async def create(**kwargs: object) -> str:
        calls.append(str(kwargs["model"]))
        return "should-not-be-issued"

    service = services("gemini-3.1-flash-live-preview", "gemini-2.5-flash-native-audio-preview-12-2025")
    monkeypatch.setattr(voice_router, "_create_ephemeral_voice_token", create)

    with pytest.raises(HTTPException) as error:
        await voice_router.get_voice_token(Response(), service, context(), fallback_grant="invalid-grant-that-is-long-enough")

    assert error.value.status_code == 403
    assert calls == []
    assert service.quota.reserve_count == 0
    assert service.quota.commit_count == 0
    assert service.quota.refund_count == 0


@pytest.mark.asyncio
async def test_retired_gemini_25_alias_is_rejected_before_provider_call(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    async def create(**kwargs: object) -> str:
        calls.append(str(kwargs["model"]))
        return "should-not-be-issued"

    service = services("gemini-2.5-flash-live-preview", "gemini-2.5-flash-live-preview")
    monkeypatch.setattr(voice_router, "_create_ephemeral_voice_token", create)

    with pytest.raises(HTTPException) as error:
        await voice_router.get_voice_token(Response(), service, context())

    assert error.value.status_code == 503
    assert error.value.detail["code"] == "gemini_live_model_unsupported"
    assert calls == []
    assert service.quota.reserve_count == 0
    assert service.quota.commit_count == 0
    assert service.quota.refund_count == 0
