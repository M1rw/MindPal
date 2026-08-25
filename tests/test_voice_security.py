from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException, Response
from pydantic import SecretStr, ValidationError

import importlib

from backend.api.dependencies import http_error_from_app_error
from backend.core.config import Settings
from backend.core.errors import RateLimitError
from backend.services.idempotency_service import IdempotencyClaim
from backend.services.quota_service import QuotaExceededError, QuotaSnapshot

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


def test_live_model_resource_name_is_normalized_for_ephemeral_constraints() -> None:
    assert voice_router._live_model_resource_name("gemini-3.1-flash-live-preview") == "models/gemini-3.1-flash-live-preview"
    assert voice_router._live_model_resource_name("models/gemini-2.5-flash-native-audio-preview-12-2025") == "models/gemini-2.5-flash-native-audio-preview-12-2025"


def _services() -> SimpleNamespace:
    settings = SimpleNamespace(
        GEMINI_API_KEY=SecretStr("permanent-provider-secret"),
        GEMINI_LIVE_MODEL="gemini-2.5-flash-native-audio-preview-12-2025",
        GEMINI_LIVE_FALLBACK_MODEL="gemini-2.5-flash-native-audio-preview-12-2025",
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
    async def fake_create(**kwargs: object) -> str:
        assert kwargs["api_version"] == "v1beta"
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
    assert result.websocket_url.endswith("v1beta.GenerativeService.BidiGenerateContentConstrained")
    assert result.model == "gemini-2.5-flash-native-audio-preview-12-2025"
    assert response.headers["cache-control"] == "no-store, private"


@pytest.mark.asyncio
async def test_voice_transport_diagnostic_records_only_sanitized_socket_metadata() -> None:
    payload = voice_router.VoiceTransportDiagnosticRequest(
        model="gemini-2.5-flash-native-audio-preview-12-2025",
        close_code=1008,
        close_reason="Policy violation",
        was_clean=True,
        setup_complete=True,
        greeting_sent=True,
        duration_ms=23_000,
    )

    response = await voice_router.report_voice_transport_diagnostic(payload=payload, context=_context())

    assert response.status_code == 204
    with pytest.raises(ValidationError):
        voice_router.VoiceTransportDiagnosticRequest(
            model="gemini-2.5-flash-native-audio-preview-12-2025",
            close_code=1008,
            was_clean=True,
            setup_complete=True,
            greeting_sent=True,
            duration_ms=23_000,
            transcript="user speech must never be accepted",
        )


@pytest.mark.asyncio
async def test_voice_delivery_diagnostic_accepts_counters_but_rejects_voice_content() -> None:
    payload = voice_router.VoiceDeliveryDiagnosticRequest(
        model="gemini-2.5-flash-native-audio-preview-12-2025",
        audio_parts=12,
        input_transcription_events=2,
        output_transcription_events=3,
        transcript_callback_events=3,
        model_text_parts=0,
        turn_complete_events=2,
        interrupted_events=1,
        fact_gated_audio_parts=0,
        end_reason="client_stop",
    )

    response = await voice_router.report_voice_delivery_diagnostic(payload=payload, context=_context())

    assert response.status_code == 204
    with pytest.raises(ValidationError):
        voice_router.VoiceDeliveryDiagnosticRequest(
            model="gemini-2.5-flash-native-audio-preview-12-2025",
            audio_parts=12,
            input_transcription_events=2,
            output_transcription_events=3,
            transcript_callback_events=3,
            model_text_parts=0,
            turn_complete_events=2,
            interrupted_events=1,
            fact_gated_audio_parts=0,
            end_reason="client_stop",
            transcript="spoken content must never be accepted",
        )


def test_voice_rate_and_quota_errors_preserve_retry_after_for_recovery_clients() -> None:
    rate_error = http_error_from_app_error(
        RateLimitError("Too many requests", details={"retry_after_seconds": 73}),
        request_id="req-rate",
    )
    quota_error = http_error_from_app_error(
        QuotaExceededError("Usage limit reached", details={"usage": {"reset_5h_seconds": 301}}),
        request_id="req-quota",
    )

    assert rate_error.headers == {"Retry-After": "73"}
    assert quota_error.headers == {"Retry-After": "301"}


def test_voice_long_call_defaults_allow_provider_socket_renewal() -> None:
    assert Settings.model_fields["VOICE_TOKEN_RATE_LIMIT_PER_HOUR"].default == 16
    assert Settings.model_fields["VOICE_SESSION_QUOTA_COST"].default == 1
    assert Settings.model_fields["GEMINI_LIVE_MODEL"].default == "gemini-2.5-flash-native-audio-preview-12-2025"
    assert Settings.model_fields["GEMINI_LIVE_FALLBACK_MODEL"].default == "gemini-2.5-flash-native-audio-preview-12-2025"


@pytest.mark.asyncio
async def test_gemini_25_live_voice_token_uses_v1beta_websocket(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_create(**kwargs: object) -> str:
        assert kwargs["model"] == "gemini-2.5-flash-native-audio-preview-12-2025"
        assert kwargs["api_version"] == "v1beta"
        return "live-25-ephemeral-token"

    services = _services()
    services.settings.GEMINI_LIVE_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"
    monkeypatch.setattr(voice_router, "_create_ephemeral_voice_token", fake_create)

    result = await voice_router.get_voice_token(response=Response(), services=services, context=_context())

    assert result.model == "gemini-2.5-flash-native-audio-preview-12-2025"
    assert result.websocket_url.endswith("v1beta.GenerativeService.BidiGenerateContentConstrained")


@pytest.mark.asyncio
async def test_live_voice_token_falls_back_to_gemini_25_once(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, str]] = []

    async def fake_create(**kwargs: object) -> str:
        calls.append((str(kwargs["model"]), str(kwargs["api_version"])))
        if len(calls) == 1:
            raise RuntimeError("primary Live model unavailable")
        return "fallback-live-25-ephemeral-token"

    services = _services()
    services.settings.GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview"
    services.settings.GEMINI_LIVE_FALLBACK_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"
    monkeypatch.setattr(voice_router, "_create_ephemeral_voice_token", fake_create)

    result = await voice_router.get_voice_token(response=Response(), services=services, context=_context())

    assert calls == [
        ("gemini-3.1-flash-live-preview", "v1beta"),
        ("gemini-2.5-flash-native-audio-preview-12-2025", "v1beta"),
    ]
    assert result.model == "gemini-2.5-flash-native-audio-preview-12-2025"
    assert result.websocket_url.endswith("v1beta.GenerativeService.BidiGenerateContentConstrained")


@pytest.mark.asyncio
async def test_native_audio_voice_token_uses_v1beta_websocket_and_ephemeral_token(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_create(**kwargs: object) -> str:
        assert kwargs["model"] == "gemini-2.5-flash-native-audio-preview-12-2025"
        assert kwargs["api_version"] == "v1beta"
        return "native-audio-ephemeral-token"

    services = _services()
    services.settings.GEMINI_LIVE_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"
    monkeypatch.setattr(voice_router, "_create_ephemeral_voice_token", fake_create)

    result = await voice_router.get_voice_token(response=Response(), services=services, context=_context())

    assert result.model == "gemini-2.5-flash-native-audio-preview-12-2025"
    assert result.websocket_url.endswith("v1beta.GenerativeService.BidiGenerateContentConstrained")


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


@pytest.mark.asyncio
async def test_voice_current_fact_verification_uses_backend_web_evidence(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Registry:
        def __init__(self) -> None:
            self.calls: list[tuple[str, dict[str, str]]] = []

        async def execute(self, name: str, args: dict[str, str], context: object) -> SimpleNamespace:
            self.calls.append((name, args))
            assert getattr(context, "authenticated") is True
            return SimpleNamespace(
                ok=True,
                to_dict=lambda: {
                    "name": "web_search",
                    "data": {"results": [{"title": "NYC", "url": "https://www.nyc.gov/"}]},
                },
            )

    services = _services()
    services.settings.TOOL_RATE_LIMIT_PER_MINUTE = 20
    services.settings.WEB_SEARCH_RATE_LIMIT_PER_HOUR = 10
    registry = _Registry()
    monkeypatch.setattr(voice_router, "_get_verified_fact_registry", lambda: registry)

    result = await voice_router.verify_current_voice_fact(
        payload=voice_router.VoiceVerifiedFactRequest(query="Who is the mayor of New York?"),
        services=services,
        context=_context(),
    )

    assert result.required is True
    assert result.verified is True
    assert result.evidence is not None
    assert registry.calls == [("web_search", {"query": "Who is the mayor of New York?"})]


@pytest.mark.asyncio
async def test_voice_current_fact_verification_rejects_empty_search_results(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Registry:
        async def execute(self, *_: object, **__: object) -> SimpleNamespace:
            return SimpleNamespace(ok=True, to_dict=lambda: {"name": "web_search", "data": {"results": []}})

    services = _services()
    services.settings.TOOL_RATE_LIMIT_PER_MINUTE = 20
    services.settings.WEB_SEARCH_RATE_LIMIT_PER_HOUR = 10
    monkeypatch.setattr(voice_router, "_get_verified_fact_registry", lambda: _Registry())

    result = await voice_router.verify_current_voice_fact(
        payload=voice_router.VoiceVerifiedFactRequest(query="Who is the mayor of New York?"),
        services=services,
        context=_context(),
    )

    assert result.verified is False
    assert result.error == "verification_unavailable"


@pytest.mark.asyncio
async def test_voice_current_fact_verification_does_not_search_static_question(monkeypatch: pytest.MonkeyPatch) -> None:
    services = _services()
    result = await voice_router.verify_current_voice_fact(
        payload=voice_router.VoiceVerifiedFactRequest(query="What is a sales channel?"),
        services=services,
        context=_context(),
    )

    assert result.required is False
    assert result.verified is False
    assert result.error == "verification_not_required"
