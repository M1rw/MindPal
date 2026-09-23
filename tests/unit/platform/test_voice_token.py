# tests/unit/platform/test_voice_token.py — Gemini Live mint is real, never vt_*

from __future__ import annotations

from datetime import datetime

import pytest

from backend.core.errors import AppError
from backend.domain.voice.services import token as token_mod
from backend.domain.voice.services.token import VoiceTokenService, constrained_ws_url, google_mint_error_message


def test_constrained_ws_url_uses_ephemeral_access_token() -> None:
    url = constrained_ws_url("auth_tokens/abc+def")
    assert "v1alpha" in url
    assert "BidiGenerateContentConstrained" in url
    assert "access_token=" in url
    assert "vt_" not in url
    assert "auth_tokens/abc" in url
    assert "vt_" not in url


def test_mint_locks_provider_safety_settings_into_the_token(monkeypatch: pytest.MonkeyPatch) -> None:
    """Harassment and dangerous-content must not cut audio on a swear or a disclosure.

    BLOCK_MEDIUM_AND_ABOVE on harassment is what froze live calls on "fuck you".
    """
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    captured: dict[str, object] = {}

    def poster(url: str, headers: dict, payload: dict, timeout: float) -> dict:
        captured["payload"] = payload
        return {"name": "auth_tokens/with-safety"}

    grant = VoiceTokenService(poster=poster).mint_ephemeral_token()
    assert grant["safety_settings_applied"] is True
    payload = captured["payload"]
    assert isinstance(payload, dict)
    settings = payload["bidiGenerateContentSetup"]["safetySettings"]
    assert [row["category"] for row in settings] == list(token_mod.LIVE_SAFETY_CATEGORIES)
    by_category = {row["category"]: row["threshold"] for row in settings}
    assert by_category == token_mod.LIVE_SAFETY_THRESHOLDS
    assert by_category["HARM_CATEGORY_HARASSMENT"] == "BLOCK_NONE"
    assert by_category["HARM_CATEGORY_HATE_SPEECH"] == "BLOCK_NONE"
    assert by_category["HARM_CATEGORY_SEXUALLY_EXPLICIT"] == "BLOCK_NONE"
    assert by_category["HARM_CATEGORY_DANGEROUS_CONTENT"] == "BLOCK_NONE"
    # The browser sends back exactly what the provider accepted.
    assert grant["setup"]["setup"]["safetySettings"] == settings
    # `method` is Vertex-only; sending it on the Gemini API path is an error.
    assert all("method" not in row for row in settings)


def test_mint_reverts_safety_settings_when_the_provider_names_the_field(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify, do not assume. Constrained v1alpha has 400'd unknown fields before."""
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    payloads: list[dict] = []

    def poster(url: str, headers: dict, payload: dict, timeout: float) -> dict:
        payloads.append(payload)
        if "safetySettings" in payload["bidiGenerateContentSetup"]:
            raise AppError(
                "unavailable",
                'Live voice could not start. Gemini INVALID_ARGUMENT: Unknown name "safetySettings" at \'bidi_generate_content_setup\'.',
                details={
                    "provider_status": 400,
                    "provider_status_name": "INVALID_ARGUMENT",
                    "provider_endpoint": token_mod.AUTH_TOKENS_URL,
                },
            )
        return {"name": "auth_tokens/no-safety"}

    grant = VoiceTokenService(poster=poster).mint_ephemeral_token()
    assert grant["token"] == "auth_tokens/no-safety"
    assert grant["safety_settings_applied"] is False
    assert "safetySettings" not in grant["setup"]["setup"]
    assert any("safetySettings" in row["bidiGenerateContentSetup"] for row in payloads)
    assert payloads[-1]["bidiGenerateContentSetup"].get("safetySettings") is None


def test_unrelated_provider_failures_are_not_blamed_on_safety_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    calls: list[dict] = []

    def poster(url: str, headers: dict, payload: dict, timeout: float) -> dict:
        calls.append(payload)
        raise AppError(
            "unavailable",
            "Live voice could not start. Gemini PERMISSION_DENIED: API key not valid.",
            details={"provider_status": 403, "provider_status_name": "PERMISSION_DENIED"},
        )

    with pytest.raises(AppError) as exc:
        VoiceTokenService(poster=poster).mint_ephemeral_token()
    assert exc.value.details["provider_status"] == 403
    assert len(calls) == 1


def test_safety_settings_kill_switch(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    monkeypatch.setenv("MINDPAL_VOICE_SAFETY_SETTINGS", "0")
    grant = VoiceTokenService(poster=lambda *args: {"name": "auth_tokens/off"}).mint_ephemeral_token()
    assert grant["safety_settings_applied"] is False
    assert "safetySettings" not in grant["setup"]["setup"]


def test_mint_fail_closed_without_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    service = VoiceTokenService(poster=lambda *args: {"name": "should-not-run"})
    with pytest.raises(AppError) as exc:
        service.mint_ephemeral_token()
    assert exc.value.code == "unavailable"
    assert "dictation" in exc.value.message.lower()


def test_mint_uses_provider_token_not_vt_stub(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    captured: dict[str, object] = {}

    def poster(url: str, headers: dict, payload: dict, timeout: float) -> dict:
        captured["url"] = url
        captured["payload"] = payload
        captured["timeout"] = timeout
        assert headers["x-goog-api-key"] == "test-gemini-key"
        return {"name": "auth_tokens/live-ephemeral-grant"}

    grant = VoiceTokenService(poster=poster).mint_ephemeral_token()
    assert grant["token"] == "auth_tokens/live-ephemeral-grant"
    assert not grant["token"].startswith("vt_")
    assert "v1alpha" in grant["ws_url"]
    assert "BidiGenerateContentConstrained" in grant["ws_url"]
    assert grant["setup"]["setup"]["model"] == "models/gemini-3.8-live"
    assert grant["setup"]["setup"]["generationConfig"]["responseModalities"] == ["AUDIO"]
    assert grant["setup_timeout_ms"] == 12_000
    payload = captured["payload"]
    assert isinstance(payload, dict)
    assert captured["url"] == token_mod.AUTH_TOKENS_URL
    assert payload["uses"] == 1
    assert "expireTime" in payload
    expire = datetime.fromisoformat(payload["expireTime"].replace("Z", "+00:00"))
    new_session = datetime.fromisoformat(payload["newSessionExpireTime"].replace("Z", "+00:00"))
    ttl = (expire - new_session).total_seconds() + token_mod.NEW_SESSION_TTL_SECONDS
    assert ttl >= 1800
    assert token_mod.TOKEN_TTL_SECONDS == 1800
    assert token_mod.TOKEN_TTL_SECONDS >= 30 * 60
    assert "newSessionExpireTime" in payload
    assert "liveConnectConstraints" not in payload
    setup = payload["bidiGenerateContentSetup"]
    assert "sessionResumption" in setup
    assert setup["sessionResumption"] == {}
    assert setup["model"].startswith("models/")
    assert setup["generationConfig"]["responseModalities"] == ["AUDIO"]
    assert setup["generationConfig"]["speechConfig"]["voiceConfig"]["prebuiltVoiceConfig"]["voiceName"] == "Sulafat"
    assert setup["generationConfig"]["temperature"] == token_mod.LIVE_TEMPERATURE
    vad = setup["realtimeInputConfig"]["automaticActivityDetection"]
    assert vad["prefixPaddingMs"] == token_mod.LIVE_PREFIX_PADDING_MS
    assert vad["silenceDurationMs"] == token_mod.LIVE_SILENCE_DURATION_MS
    # LOW: room tone and MindPal's own echo must not count as the caller starting.
    assert vad["startOfSpeechSensitivity"] == "START_SENSITIVITY_HIGH"
    assert vad["endOfSpeechSensitivity"] == "END_SENSITIVITY_LOW"
    # See the snake-case assertion below: relaxed so a mid-story pause is not
    # treated as end of turn.
    assert 1200 <= vad["silenceDurationMs"] <= 2000
    # Off by default: proactive audio lets the model choose silence (`<ctrl46>`
    # and an empty turn), which on a one-to-one call is ignoring the caller.
    assert "proactivity" not in setup
    assert grant["proactivity_applied"] is False
    assert "inputAudioTranscription" in setup
    assert "outputAudioTranscription" in setup
    tools = setup["tools"]
    names = [row["name"] for row in tools[0]["functionDeclarations"]]
    assert names == ["set_expression", "set_mood", "report_risk", "search_memory", "search_past_chats"]
    assert "wink" in tools[0]["functionDeclarations"][0]["parameters"]["properties"]["expression"]["enum"]
    assert "heart" in tools[0]["functionDeclarations"][0]["parameters"]["properties"]["expression"]["enum"]
    assert tools[0]["functionDeclarations"][0]["behavior"] == "NON_BLOCKING"
    assert tools[0]["functionDeclarations"][1]["behavior"] == "NON_BLOCKING"
    assert "awake" in tools[0]["functionDeclarations"][1]["parameters"]["properties"]["state"]["enum"]
    instruction = setup["systemInstruction"]["parts"][0]["text"]
    head = instruction[:500].lower()
    assert head.startswith("you are mindpal")
    assert "if they ask your name" in head
    assert "say mindpal" in head
    assert "you can hear them" in head
    assert "live voice call" in head
    assert "not a therapist" in head
    assert "spoken wellness companion" in instruction.lower()
    assert "actual words they just said" in instruction.lower()
    assert "do not repeat" in instruction.lower()
    assert "أيوه" in instruction
    assert "set_expression" in instruction
    assert "set_mood" in instruction
    assert "wink" in instruction
    assert "detected" in instruction.lower()
    assert "here to support" not in instruction.lower()
    assert "stay on this voice call" in instruction.lower()
    assert "988" in instruction
    assert "741741" in instruction
    assert "not a crisis line" in instruction.lower()
    assert "stop and encourage" not in instruction.lower()
    assert "voice sulafat" in instruction.lower()
    assert "your voice is called" in instruction.lower()
    assert "never re-introduce yourself" in instruction.lower()
    assert instruction.lower().startswith("you are mindpal. your voice is called")
    assert "do not wait for them to speak first" in instruction.lower()
    # A friend, not a helpline: follow-up questions, no stock sympathy.
    assert "close friend" in instruction.lower()
    assert "follow-up question" in instruction.lower()
    assert "only if needed" not in instruction.lower()
    assert "never use stock sympathy" in instruction.lower()
    # One-to-one call: never address the caller as a group.
    assert "sorry to interrupt" not in instruction.lower()
    assert "you guys" not in instruction.lower()
    assert "one-to-one call" in instruction.lower()
    assert "never answer with silence" in instruction.lower()
    assert "enableAffectiveDialog" not in setup
    assert "proactivity" not in setup


def test_mint_rejects_vt_shaped_provider_response(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    service = VoiceTokenService(poster=lambda *args: {"token": "vt_should_never_ship"})
    with pytest.raises(AppError) as exc:
        service.mint_ephemeral_token()
    assert exc.value.code == "unavailable"


def test_auth_tokens_url_is_v1alpha() -> None:
    assert token_mod.AUTH_TOKENS_URL.endswith("/v1alpha/auth_tokens")


def test_google_mint_error_includes_status_class() -> None:
    status_name, message = google_mint_error_message(
        400,
        '{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"Unknown name \\"liveConnectConstraints\\"."}}',
    )
    assert status_name == "INVALID_ARGUMENT"
    assert "liveConnectConstraints" in message


def test_rest_mint_surfaces_google_error_class(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")

    def poster(url: str, headers: dict, payload: dict, timeout: float) -> dict:
        __import__("backend.domain.voice.providers.gemini.errors", fromlist=["x"]).raise_provider_http(
            400,
            '{"error":{"status":"INVALID_ARGUMENT","message":"Unknown name \\"liveConnectConstraints\\"."}}',
            endpoint=url,
        )
        raise AssertionError("unreachable")

    with pytest.raises(AppError) as exc:
        VoiceTokenService(poster=poster).mint_ephemeral_token()
    assert exc.value.code == "unavailable"
    # The provider's wording is kept for logs and for the setup-field probes,
    # but it is not what the caller is told: an upstream error string can name
    # the project, the model or the credential that failed.
    assert "INVALID_ARGUMENT" in exc.value.internal_message
    assert "liveConnectConstraints" in exc.value.internal_message
    assert exc.value.message == token_mod.PROVIDER_UNAVAILABLE_MESSAGE
    assert "INVALID_ARGUMENT" not in exc.value.message
    assert exc.value.details["provider_status_name"] == "INVALID_ARGUMENT"


def test_sdk_mint_uses_v1alpha_and_live_connect_constraints(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    captured: dict[str, object] = {}

    def creator(api_key: str, config: dict) -> str:
        captured["api_key"] = api_key
        captured["config"] = config
        assert api_key == "test-gemini-key"
        return "auth_tokens/sdk-grant"

    grant = VoiceTokenService(token_creator=creator).mint_ephemeral_token()
    assert grant["token"] == "auth_tokens/sdk-grant"
    assert grant["api_version"] == "v1alpha"
    assert grant["model"] == "models/gemini-3.8-live"
    assert grant["voice_id"] == "Sulafat"
    assert "v1alpha" in grant["ws_url"]
    config = captured["config"]
    assert isinstance(config, dict)
    assert config["uses"] == 1
    assert isinstance(config["expire_time"], datetime)
    assert config["expire_time"].tzinfo is not None
    constraints = config["live_connect_constraints"]
    assert constraints["model"].startswith("models/")
    assert constraints["config"]["response_modalities"] == ["AUDIO"]
    assert constraints["config"]["speech_config"]["voice_config"]["prebuilt_voice_config"]["voice_name"] == "Sulafat"
    assert constraints["config"]["temperature"] == token_mod.LIVE_TEMPERATURE
    snake_vad = constraints["config"]["realtime_input_config"]["automatic_activity_detection"]
    assert snake_vad["silence_duration_ms"] == token_mod.LIVE_SILENCE_DURATION_MS
    assert snake_vad["prefix_padding_ms"] == token_mod.LIVE_PREFIX_PADDING_MS
    assert snake_vad["end_of_speech_sensitivity"] == "END_SENSITIVITY_LOW"
    # Relaxed deliberately: 700ms with HIGH end sensitivity cut callers off
    # mid-story, and in a wellness call the pause before the hard part of a
    # sentence IS the conversation. Barge-in is start-of-speech, not this.
    assert 1200 <= snake_vad["silence_duration_ms"] <= 2000
    tools = constraints["config"]["tools"]
    names = [row["name"] for row in tools[0]["function_declarations"]]
    assert names == ["set_expression", "set_mood", "report_risk", "search_memory", "search_past_chats"]
    assert "wink" in tools[0]["function_declarations"][0]["parameters"]["properties"]["expression"]["enum"]
    assert tools[0]["function_declarations"][1]["behavior"] == "NON_BLOCKING"
    assert constraints["config"]["session_resumption"] == {}
    instruction = str(constraints["config"]["system_instruction"])
    assert instruction.lower().startswith("you are mindpal")
    assert "if they ask your name" in instruction.lower()
    assert "you can hear them" in instruction.lower()
    snake_safety = constraints["config"]["safety_settings"]
    assert {row["category"]: row["threshold"] for row in snake_safety}["HARM_CATEGORY_HARASSMENT"] == "BLOCK_NONE"
    assert {row["category"]: row["threshold"] for row in snake_safety}["HARM_CATEGORY_HATE_SPEECH"] == "BLOCK_NONE"
    assert "proactivity" not in constraints["config"]


def test_mint_names_the_configured_voice_in_the_instruction(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    monkeypatch.setenv("GEMINI_LIVE_VOICE", "Kore")
    captured: dict[str, object] = {}

    def poster(url: str, headers: dict, payload: dict, timeout: float) -> dict:
        captured["payload"] = payload
        return {"name": "auth_tokens/kore"}

    grant = VoiceTokenService(poster=poster).mint_ephemeral_token()
    assert grant["voice_id"] == "Kore"
    instruction = captured["payload"]["bidiGenerateContentSetup"]["systemInstruction"]["parts"][0]["text"]
    assert "voice Kore" in instruction
    assert "say MindPal, voice Kore" in instruction


def test_mint_retries_without_session_resumption_when_provider_rejects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    payloads: list[dict] = []

    def poster(url: str, headers: dict, payload: dict, timeout: float) -> dict:
        payloads.append(payload)
        if "sessionResumption" in payload["bidiGenerateContentSetup"]:
            raise AppError(
                "unavailable",
                'Live voice could not start. Gemini INVALID_ARGUMENT: Unknown name "sessionResumption" at \'bidi_generate_content_setup\'.',
                details={
                    "provider_status": 400,
                    "provider_status_name": "INVALID_ARGUMENT",
                    "provider_endpoint": token_mod.AUTH_TOKENS_URL,
                },
            )
        return {"name": "auth_tokens/no-resume"}

    grant = VoiceTokenService(poster=poster).mint_ephemeral_token()
    assert grant["token"] == "auth_tokens/no-resume"
    assert grant["session_resumption_applied"] is False
    assert "sessionResumption" not in grant["setup"]["setup"]
    assert any("sessionResumption" in row["bidiGenerateContentSetup"] for row in payloads)


def test_mint_can_lock_a_resumption_handle(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    captured: dict[str, object] = {}

    def poster(url: str, headers: dict, payload: dict, timeout: float) -> dict:
        captured["payload"] = payload
        return {"name": "auth_tokens/resume"}

    grant = VoiceTokenService(poster=poster).mint_ephemeral_token(resumption_handle="handle-abc")
    setup = captured["payload"]["bidiGenerateContentSetup"]
    assert setup["sessionResumption"] == {"handle": "handle-abc"}
    assert grant["setup"]["setup"]["sessionResumption"] == {"handle": "handle-abc"}


def test_mint_retries_without_proactivity_when_provider_rejects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MINDPAL_VOICE_PROACTIVE_AUDIO", "true")
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    payloads: list[dict] = []

    def poster(url: str, headers: dict, payload: dict, timeout: float) -> dict:
        payloads.append(payload)
        if "proactivity" in payload["bidiGenerateContentSetup"]:
            raise AppError(
                "unavailable",
                'Live voice could not start. Gemini INVALID_ARGUMENT: Unknown name "proactivity" at \'bidi_generate_content_setup\'.',
                details={
                    "provider_status": 400,
                    "provider_status_name": "INVALID_ARGUMENT",
                    "provider_endpoint": token_mod.AUTH_TOKENS_URL,
                },
            )
        return {"name": "auth_tokens/no-proactivity"}

    grant = VoiceTokenService(poster=poster).mint_ephemeral_token()
    assert grant["token"] == "auth_tokens/no-proactivity"
    assert grant["proactivity_applied"] is False
    assert "proactivity" not in grant["setup"]["setup"]
    assert any("proactivity" in row["bidiGenerateContentSetup"] for row in payloads)



def test_proactive_audio_is_off_unless_opted_in(monkeypatch) -> None:
    """The model must not get to decide the caller is not worth answering."""
    from backend.domain.voice.services.token import voice_proactive_audio_enabled

    monkeypatch.delenv("MINDPAL_VOICE_PROACTIVE_AUDIO", raising=False)
    assert voice_proactive_audio_enabled() is False
    monkeypatch.setenv("MINDPAL_VOICE_PROACTIVE_AUDIO", "true")
    assert voice_proactive_audio_enabled() is True


def test_mint_with_custom_voice_and_personalization(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    captured: dict[str, object] = {}

    def poster(url: str, headers: dict, payload: dict, timeout: float) -> dict:
        captured["payload"] = payload
        return {"name": "auth_tokens/custom-voice-grant"}

    service = VoiceTokenService(poster=poster)
    grant = service.mint_ephemeral_token(
        voice_id="Aoede",
        voice_language="ar",
        personalization={"baseStyle": "concise", "warmth": "direct"},
    )
    assert grant["token"] == "auth_tokens/custom-voice-grant"
    assert grant["voice_id"] == "Aoede"
    payload = captured["payload"]
    setup = payload["bidiGenerateContentSetup"]
    assert setup["generationConfig"]["speechConfig"]["voiceConfig"]["prebuiltVoiceConfig"]["voiceName"] == "Aoede"
    text = setup["systemInstruction"]["parts"][0]["text"]
    assert "Aoede" in text
    assert "Arabic" in text
    assert "plain-spoken" in text or "direct" in text
    assert "concise" in text

