# tests/backend/voice/test_voice_crisis_classifier.py — Gemini JSON live-voice stay/escalate

from __future__ import annotations

import inspect

import pytest

from backend.domain.safety.modes.voice import classify as voice_classify_mod
from backend.domain.safety.modes.voice.classify import (
    CRISIS_SELF_HARM,
    DISTRESS_SUPPORT,
    IMMINENT_ESCALATE,
    NOT_CRISIS,
    STAY_SUPPORT_NOTE,
    VOICE_CRISIS_SYSTEM,
    VoiceCrisisClassifier,
    _parse_label,
    speak_then_pause_note,
)
from backend.infra.llm.gateway import LLMGateway, LLMGatewayError


def _classifier(payload: str | Exception) -> VoiceCrisisClassifier:
    def generate_json(**kwargs) -> str:
        if isinstance(payload, Exception):
            raise payload
        return payload

    return VoiceCrisisClassifier(generate_json=generate_json)


def test_production_classifier_has_no_keyword_authority() -> None:
    source = inspect.getsource(voice_classify_mod)
    assert "_IMMINENT_PHYSICAL" not in source
    assert "_DISTRESS_MARKERS" not in source
    assert "confirm_voice_label" not in source
    assert "has_imminent_evidence" not in source
    assert "infer_danger_kind" not in source


def test_kill_myself_laughing_is_not_crisis() -> None:
    verdict = _classifier('{"label":"not_crisis"}').classify("i could kill myself laughing")
    assert verdict.verified is True
    assert verdict.is_distress_support is False
    assert verdict.is_imminent is False
    assert verdict.label == NOT_CRISIS


def test_want_to_die_tonight_is_stay_support() -> None:
    verdict = _classifier('{"label":"distress_support"}').classify("I want to die tonight")
    assert verdict.verified is True
    assert verdict.is_distress_support is True
    assert verdict.is_imminent is False
    assert verdict.label == DISTRESS_SUPPORT
    assert verdict.crisis_response is None


def test_kill_my_self_asr_spacing_is_stay_support() -> None:
    verdict = _classifier('{"label":"distress_support"}').classify("i want to kill my self")
    assert verdict.is_distress_support is True
    assert verdict.is_imminent is False


def test_arabic_intent_is_stay_support() -> None:
    verdict = _classifier('{"label":"distress_support"}').classify("بدي اموت الليلة")
    assert verdict.is_distress_support is True
    assert verdict.is_imminent is False


def test_plan_with_means_now_is_imminent() -> None:
    verdict = _classifier(
        '{"label":"imminent_escalate","danger_kind":"self_harm"}'
    ).classify("I have the pills and I am taking them now")
    assert verdict.verified is True
    assert verdict.is_imminent is True
    assert verdict.is_distress_support is False
    assert verdict.danger_kind == "self_harm"
    assert "988" in (verdict.crisis_response or "")


def test_legacy_crisis_self_harm_label_stays_in_voice() -> None:
    assert _parse_label('{"label":"crisis_self_harm"}') == DISTRESS_SUPPORT
    verdict = _classifier(f'{{"label":"{CRISIS_SELF_HARM}"}}').classify("I want to die tonight")
    assert verdict.is_distress_support is True
    assert verdict.is_imminent is False


def test_prompt_splits_stay_from_imminent_by_meaning() -> None:
    prompt = VOICE_CRISIS_SYSTEM.lower()
    assert "distress_support" in prompt
    assert "imminent_escalate" in prompt
    assert "not_crisis" in prompt
    assert "do not match keywords" in prompt
    assert "call 911" in prompt
    assert "what's 988" in prompt or "whats 988" in prompt
    assert "swearing is not danger" in prompt
    assert "never choose imminent_escalate when unsure" in prompt
    assert "any language" in prompt or "whatever language" in prompt
    assert "joking" in prompt
    assert "banter" in prompt
    assert "user's meaning" in prompt or "user meaning" in prompt
    assert "mindpal's words never create a pause" in prompt
    assert "988" in STAY_SUPPORT_NOTE
    assert "741741" in STAY_SUPPORT_NOTE
    assert "not a crisis line" in STAY_SUPPORT_NOTE.lower()
    assert "you are mindpal" in STAY_SUPPORT_NOTE.lower()


def test_call_911_alone_follows_not_crisis_label() -> None:
    verdict = _classifier('{"label":"not_crisis"}').classify("call 911")
    assert verdict.verified is True
    assert verdict.is_imminent is False
    assert verdict.label == NOT_CRISIS


def test_swearing_follows_not_crisis_label() -> None:
    for phrase in ("fuck you", "shit", "كس امك", "يلعنك"):
        verdict = _classifier('{"label":"not_crisis"}').classify(phrase)
        assert verdict.verified is True, phrase
        assert verdict.label == NOT_CRISIS, phrase
        assert verdict.is_imminent is False, phrase


def test_running_from_attacker_is_imminent_when_model_says_so() -> None:
    phrase = "I'm running from someone trying to kill me"
    verdict = _classifier('{"label":"imminent_escalate","danger_kind":"physical"}').classify(phrase)
    assert verdict.is_imminent is True
    assert verdict.danger_kind == "physical"
    note = speak_then_pause_note(phrase, "physical")
    assert "running from someone trying to kill me" in note.lower()
    assert "pause the spoken call" in note.lower()


def test_arabic_physical_danger_is_imminent_when_model_says_so() -> None:
    phrase = "في حدا عم يحاول يقتلني وهلق عم اهرب"
    verdict = _classifier('{"label":"imminent_escalate","danger_kind":"physical"}').classify(phrase)
    assert verdict.is_imminent is True
    assert verdict.danger_kind == "physical"


def test_want_to_die_tonight_stays_when_model_says_distress() -> None:
    verdict = _classifier('{"label":"distress_support"}').classify("I want to die tonight")
    assert verdict.is_distress_support is True
    assert verdict.is_imminent is False


def test_model_imminent_is_trusted_without_a_keyword_gate() -> None:
    """No substring list may downgrade or upgrade the classifier label."""
    swear = _classifier('{"label":"imminent_escalate","danger_kind":"physical"}').classify("fuck you")
    assert swear.is_imminent is True
    nine_one_one = _classifier('{"label":"not_crisis"}').classify("call 911")
    assert nine_one_one.is_imminent is False
    ideation = _classifier('{"label":"distress_support"}').classify("I want to die tonight")
    assert ideation.is_distress_support is True


def test_gateway_failure_is_unverified_not_safe() -> None:
    verdict = _classifier(LLMGatewayError("unavailable", "down")).classify("i want to die tonight")
    assert verdict.verified is False
    assert verdict.is_distress_support is False
    assert verdict.is_imminent is False


def test_empty_transcript_is_verified_not_crisis() -> None:
    called = {"n": 0}

    def generate_json(**kwargs) -> str:
        called["n"] += 1
        return '{"label":"not_crisis"}'

    verdict = VoiceCrisisClassifier(generate_json=generate_json).classify("  ", "")
    assert verdict.verified is True
    assert verdict.is_distress_support is False
    assert called["n"] == 0


def test_model_only_988_is_not_a_pause() -> None:
    called = {"n": 0}

    def generate_json(**kwargs) -> str:
        called["n"] += 1
        return '{"label":"imminent_escalate","danger_kind":"self_harm"}'

    verdict = VoiceCrisisClassifier(generate_json=generate_json).classify(
        "",
        "If you need support you can call 988 or text HOME to 741741.",
    )
    assert verdict.verified is True
    assert verdict.is_imminent is False
    assert verdict.label == NOT_CRISIS
    assert called["n"] == 0


def test_joking_prompt_is_sent_to_the_model() -> None:
    seen: dict[str, str] = {}

    def generate_json(**kwargs) -> str:
        seen["prompt"] = str(kwargs.get("prompt") or "")
        seen["system"] = str(kwargs.get("system_instruction") or "")
        return '{"label":"not_crisis"}'

    verdict = VoiceCrisisClassifier(generate_json=generate_json).classify(
        "bro i'm gonna kill you that's hilarious call 911",
        "please call 988 if you need support",
    )
    assert verdict.label == NOT_CRISIS
    assert "USER meaning" in seen["prompt"]
    assert "Ignore MindPal" in seen["prompt"]
    assert "joking" in seen["system"].lower() or "banter" in seen["system"].lower()
    assert "call 911" in seen["system"].lower()


def test_malformed_json_is_unverified() -> None:
    verdict = _classifier("not json").classify("hello")
    assert verdict.verified is False
    assert verdict.is_distress_support is False


def test_unknown_label_is_unverified() -> None:
    verdict = _classifier('{"label":"maybe"}').classify("hello")
    assert verdict.verified is False


def test_generate_json_without_credentials_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    with pytest.raises(LLMGatewayError):
        LLMGateway().generate_json(prompt='{"label":"x"}')
