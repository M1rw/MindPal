"""The Egyptian-dialect check: a reply in Egyptian is clean, a drift into another dialect is named."""

from __future__ import annotations

import pytest

from backend.domain.chat.dialect import check_dialect


def test_egyptian_reply_is_clean_and_counted() -> None:
    report = check_dialect("دلوقتي عايز اقولك حاجة، ازاي نعمل كده؟ مش مشكلة اوي")
    assert report.clean
    assert report.egyptian >= 5


@pytest.mark.parametrize(
    ("text", "leak"),
    [
        ("خلني أعرف إيش اللي ضايقك", "ايش"),  # Gulf / Hijazi
        ("شو بدك تعمل هلق؟", "شو"),  # Levantine
        ("اللحين ابغى اساعدك", "اللحين"),  # Gulf
    ],
)
def test_other_dialects_are_named(text: str, leak: str) -> None:
    report = check_dialect(text)
    assert leak in report.foreign
    assert not report.clean


def test_formal_arabic_greeting_is_a_leak_counted_once() -> None:
    report = check_dialect("وعليكم السلام! كيف حالك اليوم؟")
    assert report.formal == ["كيف حالك"]


def test_latin_and_empty_text_do_not_crash() -> None:
    assert check_dialect("").clean
    assert check_dialect("Hello there").arabic_words == 0


from backend.domain.chat.dialect import dialect_note, user_dialect


def test_egyptian_speaker_is_detected_from_the_message_or_recent_turns() -> None:
    assert user_dialect("ازاي اقول لابويا اني مش عايز ادخل كلية الهندسة؟") == "egyptian"
    history = [{"role": "user", "content": "دلوقتي انا زهقان اوي"}, {"role": "assistant", "content": "معلش"}]
    assert user_dialect("سلام عليكم", history) == "egyptian"


@pytest.mark.parametrize("message", ["شو بدك تعمل هلق؟", "وش اسوي؟ ابغى حل", "hello", "سلام عليكم", ""])
def test_other_speakers_and_unknowns_get_no_note(message: str) -> None:
    assert user_dialect(message) == ""
    assert dialect_note(message) == ""


def test_the_note_reaches_the_prompt_for_egyptian_and_not_for_others(monkeypatch) -> None:
    from backend.tools.evals import check_case

    monkeypatch.setenv("MINDPAL_PRESSURE_OVERRIDE", "calm")
    egyptian = {"id": "t-eg", "message": "ازاي اتعامل مع زميلي ده؟ زهقت منه اوي", "expect": {"prompt_contains": ["The person writes Egyptian Arabic"]}}
    levantine = {"id": "t-lv", "message": "شو بدي اعمل مع زميلي؟ تعبت منه كتير", "expect": {}}
    assert check_case(egyptian).passed, check_case(egyptian).failures
    from backend.tools.evals import RecordingModel, _run_case
    import asyncio

    model = RecordingModel()
    asyncio.run(_run_case(levantine, model))
    assert "The person writes Egyptian Arabic" not in str(model.calls[-1].get("system_instruction"))


def test_the_note_can_be_switched_off(monkeypatch) -> None:
    from backend.configs.settings import get_settings
    from backend.tools.evals import check_case

    monkeypatch.setenv("MINDPAL_PRESSURE_OVERRIDE", "calm")
    monkeypatch.setenv("MINDPAL_DIALECT_NOTE", "0")
    get_settings.cache_clear() if hasattr(get_settings, "cache_clear") else None
    try:
        case = {"id": "t-off", "message": "ازاي اتعامل مع زميلي ده؟ زهقت منه اوي", "expect": {"prompt_contains": ["The person writes Egyptian Arabic"]}}
        assert not check_case(case).passed
    finally:
        monkeypatch.delenv("MINDPAL_DIALECT_NOTE")
        get_settings.cache_clear() if hasattr(get_settings, "cache_clear") else None


@pytest.mark.parametrize("text", ["في ناس كتير في وشك", "مرة واحدة بس، حق ربنا", "كذا مرة قلتلك"])
def test_words_egyptians_also_use_are_not_leaks(text: str) -> None:
    assert check_dialect(text).foreign == []


def _quality_after(message: str, reply: str, history=None) -> dict:
    import asyncio

    from backend.infra.observability import pulse as pulse_module
    from backend.infra.store.providers.memory import InMemoryStore
    from backend.tools.evals import RecordingModel, _run_case

    store = InMemoryStore()
    original = pulse_module._PULSE
    pulse_module._PULSE = pulse_module.PlatformPulse(store_factory=lambda: store)
    try:
        case = {"id": "t-q", "message": message, **({"history_turns": history} if history else {})}
        asyncio.run(_run_case(case, RecordingModel(reply=reply)))
        return dict(pulse_module._PULSE.snapshot(fresh=True).quality)
    finally:
        pulse_module._PULSE = original


def test_egyptian_replies_and_dialect_leaks_are_counted(monkeypatch) -> None:
    monkeypatch.setenv("MINDPAL_PRESSURE_OVERRIDE", "calm")
    clean = _quality_after("ازاي اتعامل مع زميلي ده؟ زهقت منه اوي", "ده تقيل فعلا. حصل ايه بالظبط؟")
    assert clean.get("eg_replies") == 1 and not clean.get("eg_dialect_leak")
    leaky = _quality_after("ازاي اتعامل مع زميلي ده؟ زهقت منه اوي", "خلني أعرف إيش اللي ضايقك")
    assert leaky.get("eg_dialect_leak") == 1


def test_a_challenged_reply_is_counted(monkeypatch) -> None:
    monkeypatch.setenv("MINDPAL_PRESSURE_OVERRIDE", "calm")
    history = [{"role": "user", "content": "نجحت في الامتحان"}, {"role": "assistant", "content": "حقك تزعل"}]
    counts = _quality_after("انت الي بتقول اني زعلان؟", "معاك حق، غلطتي.", history)
    assert counts.get("reply_challenged") == 1
