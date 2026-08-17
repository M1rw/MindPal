from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException, Response
from pydantic import SecretStr

import importlib

from backend.services.idempotency_service import IdempotencyClaim
from backend.services.quota_service import QuotaSnapshot

voice_router = importlib.import_module("backend.api.voice_router")


def _context() -> SimpleNamespace:
    return SimpleNamespace(
        request_id="req-voice-test",
        locale="en",
        session=SimpleNamespace(authenticated=True, user_id_hash="user-test"),
    )


class _RateLimits:
    async def consume(self, **_: object) -> None:
        return None


class _Idempotency:
    @staticmethod
    def payload_hash(payload: object) -> str:
        return "payload-hash"

    async def claim(self, **_: object) -> IdempotencyClaim:
        return IdempotencyClaim(key="claim-key", owner=True, completed=False)

    async def complete(self, **_: object) -> None:
        return None

    async def fail(self, **_: object) -> None:
        return None


class _Quota:
    async def reserve(self, **_: object) -> None:
        return None

    async def commit(self, **_: object) -> QuotaSnapshot:
        return QuotaSnapshot(2, 50, 100, 2, 500, 1000, 1)

    async def refund(self, **_: object) -> QuotaSnapshot:
        return QuotaSnapshot(0, 50, 100, 0, 500, 1000, 0)


def _services() -> SimpleNamespace:
    settings = SimpleNamespace(
        GEMINI_API_KEY=SecretStr("permanent-provider-secret"),
        GEMINI_LIVE_MODEL="gemini-2.5-flash-native-audio-preview-12-2025",
        VOICE_TOKEN_TTL_SECONDS=1800,
        VOICE_NEW_SESSION_TTL_SECONDS=60,
        VOICE_TOKEN_RATE_LIMIT_PER_HOUR=8,
        VOICE_SESSION_QUOTA_COST=2,
    )
    return SimpleNamespace(
        settings=settings,
        rate_limits=_RateLimits(),
        idempotency=_Idempotency(),
        quota=_Quota(),
    )


@pytest.mark.asyncio
async def test_voice_token_endpoint_returns_ephemeral_token_not_provider_key(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_create(**_: object) -> str:
        return "ephemeral-session-token"

    monkeypatch.setattr(voice_router, "_create_ephemeral_voice_token", fake_create)

    response = Response()
    services = _services()
    result = await voice_router.get_voice_token(
        response=response,
        services=services,
        context=_context(),
    )

    assert result.token == "ephemeral-session-token"
    assert result.token != services.settings.GEMINI_API_KEY.get_secret_value()
    assert "v1beta.GenerativeService.BidiGenerateContentConstrained" in result.websocket_url
    assert result.model == "gemini-2.5-flash-native-audio-preview-12-2025"
    assert response.headers["cache-control"] == "no-store, private"


@pytest.mark.asyncio
async def test_retired_voice_key_endpoint_never_returns_secret() -> None:
    with pytest.raises(HTTPException) as exc_info:
        await voice_router.retired_voice_key_endpoint(context=_context())
    assert exc_info.value.status_code == 410


@pytest.mark.asyncio
async def test_voice_transcription_and_summary_complete_with_sanitized_results(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _VoiceTool:
        def __init__(self, data: dict[str, str]) -> None:
            self.data = data

        async def execute(self, *_: object, **__: object) -> SimpleNamespace:
            return SimpleNamespace(ok=True, data=self.data, error=None)

    services = _services()
    services.settings.VOICE_RATE_LIMIT_PER_MINUTE = 10
    services.settings.PROVIDER_OPERATION_QUOTA_COST = 1
    monkeypatch.setattr(voice_router, "_transcribe_tool", _VoiceTool({"text": "  I feel calmer now.  "}))
    monkeypatch.setattr(
        voice_router,
        "_summarize_tool",
        _VoiceTool({"summary": "A calm discussion about a manageable next step."}),
    )

    transcription = await voice_router.transcribe_audio(
        payload=voice_router.TranscribeRequest(audio_base64="dGVzdA==", mime_type="audio/webm; codecs=opus"),
        services=services,
        context=_context(),
    )
    summary = await voice_router.summarize_call(
        payload=voice_router.SummarizeRequest(user_transcript="I feel calmer", ai_transcript="Let’s choose one next step"),
        services=services,
        context=_context(),
    )

    assert transcription.text == "I feel calmer now."
    assert transcription.usage is not None
    assert summary.summary == "A calm discussion about a manageable next step."
    assert summary.usage is not None
