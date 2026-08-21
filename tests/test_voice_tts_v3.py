from __future__ import annotations

import base64
import importlib
import io
from types import SimpleNamespace
import wave

import pytest

voice_router = importlib.import_module("backend.api.voice_router")
from backend.services.persona_voice_catalog import PersonaVoice, PersonaVoiceCatalog


def context() -> SimpleNamespace:
    return SimpleNamespace(
        request_id="req-tts-v3-test",
        locale="en",
        session=SimpleNamespace(authenticated=True, user_id_hash="user-test"),
    )


class RateLimits:
    async def consume(self, **_: object) -> None:
        return None


def wav_base64(*, sample_rate: int = 16_000, channels: int = 1) -> str:
    frames = b"\x00\x00" * (sample_rate // 10) * channels
    output = io.BytesIO()
    with wave.open(output, "wb") as wav_file:
        wav_file.setnchannels(channels)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(frames)
    return base64.b64encode(output.getvalue()).decode("ascii")


def services(tts: object) -> SimpleNamespace:
    return SimpleNamespace(
        tts=tts,
        rate_limits=RateLimits(),
        settings=SimpleNamespace(TTS_RATE_LIMIT_PER_MINUTE=60),
    )


def catalog() -> PersonaVoiceCatalog:
    return PersonaVoiceCatalog({
        "Kore": PersonaVoice("Kore", "camb", "kore-provider-id", "female", "warm_natural", False),
        "Charon": PersonaVoice("Charon", "camb", "charon-provider-id", "male", "calm_deep", False),
    })


class FakeTts:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    async def synthesize_text(self, **kwargs: object) -> SimpleNamespace:
        self.calls.append(kwargs)
        return SimpleNamespace(
            fallback_to_browser=False,
            audio_base64=wav_base64(),
        )


@pytest.mark.asyncio
async def test_persona_resolves_to_explicit_voice_id_and_audio_is_normalized(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(voice_router, "_REALTIME_TTS_CACHE", {})
    monkeypatch.setattr(voice_router, "_get_persona_voice_catalog", lambda: catalog())
    fake = FakeTts()
    result = await voice_router.synthesize_realtime_voice_tts(
        voice_router.RealtimeVoiceTtsRequest(text="mhm", persona="Kore", emotion="neutral"),
        services(fake),
        context(),
    )

    assert result.voice_id == "kore-provider-id"
    assert result.persona == "Kore"
    assert result.cached is False
    assert fake.calls[0]["voice_id"] == "kore-provider-id"
    pcm = base64.b64decode(result.audio_base64)
    assert len(pcm) % 2 == 0
    assert result.duration_ms == 100


@pytest.mark.asyncio
async def test_missing_persona_mapping_returns_controlled_nonverbal_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(voice_router, "_get_persona_voice_catalog", lambda: catalog())
    fake = FakeTts()
    result = await voice_router.synthesize_realtime_voice_tts(
        voice_router.RealtimeVoiceTtsRequest(text="mhm", persona="Unknown", emotion="neutral"),
        services(fake),
        context(),
    )

    assert result.audio_base64 == ""
    assert result.fallback == "non_verbal_hum"
    assert fake.calls == []


@pytest.mark.asyncio
async def test_unsupported_emotion_is_ignored_without_crashing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(voice_router, "_REALTIME_TTS_CACHE", {})
    monkeypatch.setattr(voice_router, "_get_persona_voice_catalog", lambda: catalog())
    fake = FakeTts()
    await voice_router.synthesize_realtime_voice_tts(
        voice_router.RealtimeVoiceTtsRequest(text="yeah", persona="Kore", emotion="playful"),
        services(fake),
        context(),
    )
    assert fake.calls[0]["response_mode"] == "normal_support"


@pytest.mark.asyncio
async def test_common_cue_cache_is_isolated_by_persona_and_emotion(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(voice_router, "_REALTIME_TTS_CACHE", {})
    monkeypatch.setattr(voice_router, "_get_persona_voice_catalog", lambda: catalog())
    fake = FakeTts()
    for persona, emotion in (("Kore", "neutral"), ("Kore", "neutral"), ("Kore", "calm"), ("Charon", "neutral")):
        result = await voice_router.synthesize_realtime_voice_tts(
            voice_router.RealtimeVoiceTtsRequest(text="mhm", persona=persona, emotion=emotion),
            services(fake),
            context(),
        )
        assert result.persona == persona
    assert len(fake.calls) == 3


def test_catalog_public_config_never_uses_a_silent_provider_default() -> None:
    resolved = catalog().resolve("Kore")
    assert resolved is not None and resolved.voice_id == "kore-provider-id"
    missing = PersonaVoiceCatalog({"Kore": PersonaVoice("Kore", "camb", None, "female", "warm_natural")})
    assert missing.is_configured("Kore") is False
    assert missing.public_config()["persona_voice_catalog"]["Kore"]["voice_id"] == "REQUIRED"
