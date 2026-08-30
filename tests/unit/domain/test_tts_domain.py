# tests/unit/domain/test_tts_domain.py

import pytest
from backend.services.domain.voice import TTSService, BrowserFallbackTTSProvider


def test_tts_service_policy_selection():
    service = TTSService()

    # Normal policy
    policy = service.select_policy(locale="en", response_mode="normal_support", safety_level="safe")
    assert policy.locale == "en"
    assert policy.external_tts_allowed is True

    # Crisis policy disables external TTS
    crisis_policy = service.select_policy(locale="en", response_mode="normal_support", safety_level="self_harm_imminent")
    assert crisis_policy.external_tts_allowed is False


@pytest.mark.asyncio
async def test_tts_service_browser_fallback():
    service = TTSService(providers=[BrowserFallbackTTSProvider()])
    res = await service.synthesize_text(text="Hello", locale="en")

    assert res.fallback_to_browser is True
    assert res.provider_used == "browser"
