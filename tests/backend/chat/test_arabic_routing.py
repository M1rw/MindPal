"""Arabic messages can be sent to a stronger model first; everything else, and a bad setting, changes nothing."""

from __future__ import annotations

import asyncio

import pytest

from backend.domain.chat.dialect import is_arabic_text
from backend.infra.llm import gateway as gw
from backend.tools.evals import RecordingModel, _run_case


@pytest.fixture(autouse=True)
def _calm(monkeypatch):
    monkeypatch.setenv("MINDPAL_PRESSURE_OVERRIDE", "calm")


def _clear_settings() -> None:
    from backend.configs.settings import get_settings

    if hasattr(get_settings, "cache_clear"):
        get_settings.cache_clear()


def test_prefer_goes_first_and_keeps_the_rest_as_spares(monkeypatch) -> None:
    monkeypatch.setattr(gw, "_has_credentials", lambda provider: True)
    ladder = [("groq", None), ("openrouter", None)]
    assert gw._prefer(ladder, "groq:openai/gpt-oss-120b") == [("groq", "openai/gpt-oss-120b"), ("groq", None), ("openrouter", None)]
    assert gw._prefer(ladder, "openrouter") == [("openrouter", None), ("groq", None)]


def test_a_bad_or_keyless_preference_is_ignored(monkeypatch) -> None:
    ladder = [("groq", None)]
    monkeypatch.setattr(gw, "_has_credentials", lambda provider: provider != "openrouter")
    assert gw._prefer(ladder, "") == ladder
    assert gw._prefer(ladder, "nonsense:model") == ladder
    assert gw._prefer(ladder, "openrouter:x") == ladder  # no key for it


def test_arabic_detection() -> None:
    assert is_arabic_text("ازيك يا باشا")
    assert not is_arabic_text("how are you")
    assert not is_arabic_text("")


@pytest.mark.parametrize(
    ("setting", "message", "expected"),
    [
        ("groq:openai/gpt-oss-120b", "ازاي اتعامل مع زميلي ده؟", "groq:openai/gpt-oss-120b"),
        ("groq:openai/gpt-oss-120b", "how do I deal with my coworker?", None),
        ("", "ازاي اتعامل مع زميلي ده؟", None),
    ],
)
def test_arabic_turns_ask_for_the_preferred_model_only_when_set(monkeypatch, setting, message, expected) -> None:
    monkeypatch.setenv("MINDPAL_ARABIC_CHAT", setting)
    _clear_settings()
    try:
        model = RecordingModel()
        asyncio.run(_run_case({"id": "t", "message": message}, model))
        assert model.calls[-1].get("prefer") == expected
    finally:
        monkeypatch.delenv("MINDPAL_ARABIC_CHAT", raising=False)
        _clear_settings()
