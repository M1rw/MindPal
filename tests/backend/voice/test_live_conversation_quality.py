# tests/backend/voice/test_live_conversation_quality.py - what made calls feel robotic and forgetful
"""A real call: every reply ended with a question, the caller's name came up
every other turn, a misheard phrase flipped the call into Spanish and then
Hindi, and after a few minutes a mid-call "hello" got a brand-new greeting
because the context window kept only about a minute of the conversation."""

from __future__ import annotations

import pytest

from backend.domain.voice.services.token import (
    LIVE_COMPRESSION_KEEP_TOKENS,
    LIVE_COMPRESSION_TRIGGER_TOKENS,
    LIVE_TEMPERATURE,
    live_setup_message,
    wellness_live_instruction,
)


@pytest.mark.parametrize("language", [None, "auto", "en", "ar", "es"])
def test_one_misheard_phrase_never_switches_the_call_language(language) -> None:
    prompt = wellness_live_instruction("Sulafat", {}, language)
    assert "almost always a mishearing" in prompt
    assert "If they speak Arabic, answer in Arabic" not in prompt


def test_replies_are_not_an_interview() -> None:
    prompt = wellness_live_instruction("Sulafat", {}, None)
    assert "Most of your turns should end with" not in prompt
    assert "Do not end every turn with a question" in prompt
    assert "Use their name rarely" in prompt


def test_a_mid_call_hello_is_not_a_new_call() -> None:
    prompt = wellness_live_instruction("Sulafat", {}, None)
    assert "never greet them again" in prompt
    assert "never ask a question you already asked" in prompt


def test_the_call_keeps_minutes_of_context_not_one_exchange() -> None:
    # ~25 tokens/s each way: the kept window must hold several minutes.
    assert LIVE_COMPRESSION_KEEP_TOKENS >= 12_000
    assert LIVE_COMPRESSION_TRIGGER_TOKENS > LIVE_COMPRESSION_KEEP_TOKENS
    setup = live_setup_message(model="models/x", voice_id="Sulafat")["setup"]
    window = setup["contextWindowCompression"]
    assert window["slidingWindow"]["targetTokens"] == str(LIVE_COMPRESSION_KEEP_TOKENS)
    assert LIVE_TEMPERATURE <= 0.75


def test_persona_v2_has_a_character_and_a_real_speaking_voice() -> None:
    prompt = wellness_live_instruction("Sulafat")
    # A character, not an assistant.
    assert "quick-witted" in prompt and "mischievous" in prompt and "opinions of your own" in prompt
    # It laughs, reacts and thinks out loud like a person on a call.
    assert "Laugh out loud" in prompt and "'hmm'" in prompt and "'oof'" in prompt
    assert "bring back things they said earlier" in prompt
    # The old cap that kept every turn to one or two sentences is gone.
    assert "By default, use one or two short sentences, then yield" not in prompt


def test_persona_v2_is_playful_but_never_romantic_and_reads_the_room() -> None:
    prompt = wellness_live_instruction("Sulafat")
    assert "never romantic or sexual" in prompt
    assert "When they are hurting, the jokes drop away" in prompt


def test_persona_v2_crisis_help_is_reachable_outside_the_us() -> None:
    prompt = wellness_live_instruction("Sulafat")
    assert "a free confidential line in their country at findahelpline" in prompt
    assert "local emergency number" in prompt
    assert "988" in prompt and "741741" in prompt and "stay on this voice call" in prompt


def test_persona_can_be_rolled_back(monkeypatch) -> None:
    from backend.configs import settings as settings_module

    monkeypatch.setenv("MINDPAL_VOICE_PERSONA", "v1")
    settings_module.get_settings.cache_clear() if hasattr(settings_module.get_settings, "cache_clear") else None
    try:
        prompt = wellness_live_instruction("Sulafat")
        assert "By default, use one or two short sentences, then yield" in prompt
        assert "quick-witted" not in prompt
    finally:
        monkeypatch.delenv("MINDPAL_VOICE_PERSONA")
        settings_module.get_settings.cache_clear() if hasattr(settings_module.get_settings, "cache_clear") else None


def test_persona_v2_shows_alive_vs_flat_and_bans_customer_service_phrases() -> None:
    prompt = wellness_live_instruction("Sulafat")
    # Examples steer the native-audio model; they must be marked as never-reuse,
    # or every caller hears the same lines.
    assert "never say these lines, invent your own every time" in prompt
    for phrase in ("what's on your mind", "loud and clear", "I'm here if you need anything else", "how about you"):
        assert phrase in prompt
