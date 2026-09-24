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
