# tests/unit/platform/test_voice_gemini_budget_config.py — provider config that costs money or silence
#
# Two regressions these pin:
#
#  1. Gemini 2.5 thinks by default, and thinking tokens are counted against
#     max_output_tokens. A classifier capped at 80 tokens could spend all of them
#     thinking and return empty text, which the gateway raises as "unavailable"
#     and the live session then treats as `safety_unverified` — paying for
#     thinking AND getting no verdict. Structured short-output calls must pin
#     thinking to zero.
#  2. A 30-minute native-audio session without contextWindowCompression exceeds
#     the provider context window mid-call and gets dropped, spending the single
#     reconnect the client allows.

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List

import pytest

from backend.core.errors import AppError
from backend.domain.voice import token as token_mod
from backend.domain.voice.token import (
    live_setup_message,
    rejects_context_window_compression,
    rest_mint_payload,
    _sdk_config,
)
from backend.infra.llm import gateway as gateway_mod
from backend.infra.llm.gateway import (
    DEFAULT_CHAT_MODEL,
    JSON_MODEL,
    JSON_THINKING_BUDGET,
    LLMGateway,
    default_chat_model,
    json_model,
)


class _RecordingClient:
    """Stands in for genai.Client and records what the gateway asked for."""

    instances: List["_RecordingClient"] = []

    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs
        self.calls: List[Dict[str, Any]] = []
        _RecordingClient.instances.append(self)
        outer = self

        class _Models:
            def generate_content(self, **call: Any) -> Any:
                outer.calls.append(call)

                class _Response:
                    text = '{"label": "not_crisis"}'

                return _Response()

        self.models = _Models()


@pytest.fixture(autouse=True)
def _clean_clients(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    _RecordingClient.instances = []
    gateway_mod.reset_llm_clients()
    yield
    gateway_mod.reset_llm_clients()


def _patch_client(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_get_client(api_key: str, *, timeout_ms: int) -> Any:
        return _RecordingClient(api_key=api_key, timeout_ms=timeout_ms)

    monkeypatch.setattr(gateway_mod, "_get_client", fake_get_client)


def test_json_calls_pin_thinking_to_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_client(monkeypatch)
    LLMGateway().generate_json(prompt="User: hi", system_instruction="sys", max_tokens=80)

    assert len(_RecordingClient.instances) == 1
    call = _RecordingClient.instances[0].calls[0]
    config = call["config"]
    thinking = getattr(config, "thinking_config", None)
    assert thinking is not None, "structured short-output calls must send a thinking config"
    assert thinking.thinking_budget == 0, (
        "thinking tokens count against max_output_tokens; an 80-token classifier "
        "that thinks returns empty text and reads as safety_unverified"
    )
    assert JSON_THINKING_BUDGET == 0


def test_json_calls_use_the_lite_model(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_client(monkeypatch)
    LLMGateway().generate_json(prompt="User: hi", max_tokens=80)
    call = _RecordingClient.instances[0].calls[0]
    assert call["model"] == JSON_MODEL
    assert "lite" in JSON_MODEL, "a 3-way label at temperature 0 does not need Flash"


def test_json_calls_carry_a_request_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_client(monkeypatch)
    LLMGateway().generate_json(prompt="User: hi")
    client = _RecordingClient.instances[0]
    assert client.kwargs["timeout_ms"] > 0, "classify gates the microphone; it must fail fast"
    assert client.kwargs["timeout_ms"] <= 10_000


def test_the_client_is_reused_across_calls(monkeypatch: pytest.MonkeyPatch) -> None:
    created: List[Dict[str, Any]] = []

    class _Types:
        @staticmethod
        def HttpOptions(**kwargs: Any) -> Any:
            return kwargs

    def fake_import(api_key: str, timeout_ms: int) -> Any:
        created.append({"api_key": api_key})
        return _RecordingClient(api_key=api_key, timeout_ms=timeout_ms)

    monkeypatch.setattr(gateway_mod, "_CLIENTS", {})
    real_get = gateway_mod._get_client

    def counting_get(api_key: str, *, timeout_ms: int) -> Any:
        key = (api_key, timeout_ms)
        cached = gateway_mod._CLIENTS.get(key)
        if cached is not None:
            return cached
        client = fake_import(api_key, timeout_ms)
        gateway_mod._CLIENTS[key] = client
        return client

    monkeypatch.setattr(gateway_mod, "_get_client", counting_get)
    gateway = LLMGateway()
    for _ in range(5):
        gateway.generate_json(prompt="User: hi")

    assert len(created) == 1, (
        "a fresh client per call meant a TLS handshake and a new pool on every "
        "classify — pure latency on a path that mutes the microphone"
    )
    assert callable(real_get)


def test_empty_response_is_still_an_error_not_a_verdict(monkeypatch: pytest.MonkeyPatch) -> None:
    class _EmptyClient(_RecordingClient):
        def __init__(self, **kwargs: Any) -> None:
            super().__init__(**kwargs)
            outer = self

            class _Models:
                def generate_content(self, **call: Any) -> Any:
                    outer.calls.append(call)

                    class _Response:
                        text = ""

                    return _Response()

            self.models = _Models()

    monkeypatch.setattr(
        gateway_mod, "_get_client", lambda api_key, *, timeout_ms: _EmptyClient(api_key=api_key)
    )
    with pytest.raises(Exception) as excinfo:
        LLMGateway().generate_json(prompt="User: hi")
    assert "empty" in str(excinfo.value).lower()


# --- Live setup: context window compression -------------------------------------


def test_live_setup_carries_context_window_compression() -> None:
    setup = live_setup_message(model="m", voice_id="Sulafat")["setup"]
    compression = setup.get("contextWindowCompression")
    assert compression, "a 30-minute native-audio call overruns the context window without this"
    assert compression["slidingWindow"]["targetTokens"]


def test_all_three_setup_shapes_agree() -> None:
    now = datetime.now(timezone.utc)
    camel = live_setup_message(model="m", voice_id="v")["setup"]
    rest = rest_mint_payload(expire_at=now, new_session_expire_at=now, model="m", voice_id="v")
    sdk = _sdk_config(expire_at=now, new_session_expire_at=now, model="m", voice_id="v")

    assert "contextWindowCompression" in camel
    assert "contextWindowCompression" in rest["bidiGenerateContentSetup"]
    assert "context_window_compression" in sdk["live_connect_constraints"]["config"]


def test_compression_can_be_dropped_when_the_provider_rejects_it() -> None:
    setup = live_setup_message(model="m", voice_id="v", compression=False)["setup"]
    assert "contextWindowCompression" not in setup
    # The browser replays exactly the setup the provider accepted, so a rejected
    # field must not survive into the WSS handshake.
    assert "model" in setup and "generationConfig" in setup


def _provider_400(message: str) -> AppError:
    """Shaped exactly like _raise_provider_http builds one, status included."""
    return AppError(
        "unavailable",
        f"Live voice could not start. Gemini INVALID_ARGUMENT: {message}",
        details={"provider_status": 400, "provider_status_name": "INVALID_ARGUMENT"},
    )


def test_named_400_on_compression_is_detected() -> None:
    assert rejects_context_window_compression(
        _provider_400('Unknown name "contextWindowCompression".')
    ) is True
    # A 400 about a different field must not silently drop compression too.
    assert rejects_context_window_compression(_provider_400('Unknown name "proactivity".')) is False
    # A non-400 is a real outage, not a field probe.
    assert rejects_context_window_compression(
        AppError("unavailable", 'Unknown name "contextWindowCompression".')
    ) is False


def test_mint_ladder_has_room_for_every_optional_field() -> None:
    import inspect

    source = inspect.getsource(token_mod.VoiceTokenService.mint_ephemeral_token)
    # Four droppable fields plus the success attempt.
    assert "range(6)" in source, "the retry ladder must be able to shed every optional field"
    for probe in (
        "rejects_context_window_compression",
        "rejects_proactivity",
        "rejects_safety_settings",
        "rejects_session_resumption",
    ):
        assert probe in source


# --- Model selection is configurable, not hardcoded ----------------------------


def test_chat_model_reads_gemini_model_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GEMINI_MODEL", raising=False)
    assert default_chat_model() == DEFAULT_CHAT_MODEL
    assert LLMGateway().default_model == DEFAULT_CHAT_MODEL

    monkeypatch.setenv("GEMINI_MODEL", "gemini-3.1-flash")
    assert default_chat_model() == "gemini-3.1-flash"
    assert LLMGateway().default_model == "gemini-3.1-flash", (
        "GEMINI_MODEL existed in .env.local but nothing read it; the model was "
        "effectively hardcoded and could not be changed without a deploy"
    )
    assert LLMGateway("explicit-model").default_model == "explicit-model"


def test_classifier_model_is_separately_overridable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GEMINI_JSON_MODEL", raising=False)
    assert json_model() == JSON_MODEL

    # The escape hatch: if validate_voice_classifier.py shows the cheap model
    # mislabelling, the safety path moves back without a code change.
    monkeypatch.setenv("GEMINI_JSON_MODEL", "gemini-2.5-flash")
    assert json_model() == "gemini-2.5-flash"

    # And it must not drag the chat model with it.
    monkeypatch.delenv("GEMINI_MODEL", raising=False)
    assert default_chat_model() == DEFAULT_CHAT_MODEL


def test_json_model_override_reaches_the_call(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_client(monkeypatch)
    monkeypatch.setenv("GEMINI_JSON_MODEL", "gemini-2.5-flash")
    LLMGateway().generate_json(prompt="User: hi")
    assert _RecordingClient.instances[0].calls[0]["model"] == "gemini-2.5-flash"


# --- In-band risk rating + classifier modes -------------------------------------


def test_report_risk_tool_is_declared_in_both_setup_shapes() -> None:
    from datetime import datetime, timezone

    camel = live_setup_message(model="m", voice_id="v")["setup"]
    names = [d["name"] for d in camel["tools"][0]["functionDeclarations"]]
    assert "report_risk" in names

    now = datetime.now(timezone.utc)
    sdk = _sdk_config(expire_at=now, new_session_expire_at=now, model="m", voice_id="v")
    snake = sdk["live_connect_constraints"]["config"]["tools"][0]["function_declarations"]
    assert [d["name"] for d in snake] == [d["name"] for d in camel["tools"][0]["functionDeclarations"]]


def test_risk_tool_prompt_refuses_to_pause_on_the_documented_not_crisis_cases() -> None:
    from backend.domain.voice.token import RISK_TOOL_DESCRIPTION

    text = RISK_TOOL_DESCRIPTION.lower()
    # The same carve-outs VOICE_CRISIS_SYSTEM makes, so both routes agree.
    for phrase in ("jok", "roasting", "swearing", "dark humour", "venting", "988"):
        assert phrase in text, f"risk tool prompt must address {phrase}"
    assert "unsure" in text and "lower" in text, "must bias away from pausing when unsure"
    assert "your own words never raise the rating" in text


def test_classifier_mode_defaults_to_full(monkeypatch: pytest.MonkeyPatch) -> None:
    from backend.domain.voice.gemini_budget import classifier_mode

    monkeypatch.delenv("MINDPAL_VOICE_CLASSIFIER", raising=False)
    assert classifier_mode() == "full", "the independent check stays on unless turned off"


def test_classifier_mode_parses_the_documented_values(monkeypatch: pytest.MonkeyPatch) -> None:
    from backend.domain.voice.gemini_budget import classifier_mode

    for value, expected in (
        ("off", "off"),
        ("0", "off"),
        ("verify", "verify"),
        ("full", "full"),
        ("1", "full"),
        ("nonsense", "full"),
    ):
        monkeypatch.setenv("MINDPAL_VOICE_CLASSIFIER", value)
        assert classifier_mode() == expected


def test_verify_mode_skips_quiet_turns_but_runs_when_risk_is_elevated() -> None:
    from backend.domain.voice.gemini_budget import should_run_classify

    common = dict(
        input_text="I have been having a rough week",
        output_text="",
        prior_input="",
        prior_fingerprint="",
        is_final=True,
        classifier_mode_override="verify",
    )
    quiet = should_run_classify(last_classify_at=1_000_000.0, now=1_000_000.0, risk_elevated=False, **common)
    assert quiet.run is False and quiet.reason == "verify_mode_quiet"

    # Elevated risk clears the verify gate, but the coalescing budget still
    # applies: an elevated rating must not be able to storm the classifier.
    too_soon = should_run_classify(
        last_classify_at=1_000_000.0, now=1_000_000.0, risk_elevated=True, **common
    )
    assert too_soon.run is False and too_soon.reason == "min_interval"

    elevated = should_run_classify(
        last_classify_at=999_995.0, now=1_000_000.0, risk_elevated=True, **common
    )
    assert elevated.run is True

    # A model that stopped reporting must still be caught by the heartbeat.
    lapsed = should_run_classify(last_classify_at=0.0, now=1_000_000.0, risk_elevated=False, **common)
    assert lapsed.run is True


def test_off_mode_still_honours_an_explicit_force() -> None:
    from backend.domain.voice.gemini_budget import should_run_classify

    decision = should_run_classify(
        input_text="anything",
        output_text="",
        prior_input="",
        prior_fingerprint="",
        last_classify_at=0,
        is_final=True,
        force=True,
        classifier_mode_override="off",
    )
    assert decision.run is True, "an explicit force is an operator decision, not a routine turn"


# --- Diagnostic model manifest ---------------------------------------------------


def test_model_manifest_names_every_path_that_serves_a_call(monkeypatch: pytest.MonkeyPatch) -> None:
    """A voice diagnostic that does not say which classifier produced a verdict
    cannot be reasoned about. The Live model is in the grant already; the chat
    and classifier models are server-side env the browser cannot see."""
    from backend.domain.voice.session import VoiceSessionService

    monkeypatch.delenv("MINDPAL_CHAT_PROVIDER", raising=False)
    monkeypatch.delenv("MINDPAL_JSON_PROVIDER", raising=False)
    monkeypatch.delenv("MINDPAL_LLM_PROVIDER", raising=False)

    manifest = VoiceSessionService.model_manifest()
    for key in (
        "live",
        "live_voice",
        "chat_provider",
        "chat_model",
        "classifier_provider",
        "classifier_model",
        "classifier_mode",
    ):
        assert key in manifest, f"manifest must name {key}"
        assert manifest[key], f"{key} must not be blank"

    assert manifest["chat_provider"] == "gemini"
    assert manifest["classifier_model"] == JSON_MODEL


def test_model_manifest_follows_the_provider_switch(monkeypatch: pytest.MonkeyPatch) -> None:
    from backend.domain.voice.session import VoiceSessionService

    monkeypatch.setenv("MINDPAL_JSON_PROVIDER", "groq")
    monkeypatch.setenv("GROQ_JSON_MODEL", "openai/gpt-oss-safeguard-20b")
    monkeypatch.setenv("MINDPAL_CHAT_PROVIDER", "openrouter")
    monkeypatch.setenv("OPENROUTER_MODEL", "google/gemma-4-31b-it:free")

    manifest = VoiceSessionService.model_manifest()
    assert manifest["classifier_provider"] == "groq"
    assert manifest["classifier_model"] == "openai/gpt-oss-safeguard-20b"
    assert manifest["chat_provider"] == "openrouter"
    assert manifest["chat_model"] == "google/gemma-4-31b-it:free"


def test_model_manifest_carries_no_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    """The manifest ships to the browser and into a downloadable report."""
    from backend.domain.voice.session import VoiceSessionService

    monkeypatch.setenv("GEMINI_API_KEY", "secret-gemini-value")
    monkeypatch.setenv("GROQ_API_KEY", "secret-groq-value")
    monkeypatch.setenv("OPENROUTER_API_KEY", "secret-or-value")

    blob = " ".join(str(v) for v in VoiceSessionService.model_manifest().values())
    assert "secret-" not in blob
    assert "sk-" not in blob
