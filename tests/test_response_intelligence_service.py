from __future__ import annotations

import pytest

from backend.core.config import Settings
from backend.core.message_classifier import classify_message
from backend.core.prompt_builder import build_tiered_prompt
from backend.services.response_intelligence_service import ResponseBrief, ResponseIntelligenceService


def _service(**overrides: object) -> ResponseIntelligenceService:
    settings = Settings(ENVIRONMENT="test", **overrides)
    return ResponseIntelligenceService(settings=settings)


def test_brief_infers_distress_and_actionable_egyptian_arabic_support() -> None:
    message = "حاسس إني مضغوط من الشغل ومش عارف أنام"
    classification = classify_message(message, locale="auto")

    brief = _service().build_brief(
        user_message=message,
        classification=classification,
        response_mode="normal_support",
    )

    assert brief.intent == "wellbeing_support"
    assert brief.emotional_state == "distressed"
    assert brief.social_tone == "warm_and_steady"
    assert brief.language_style == "natural_egyptian_arabic"
    assert brief.needs_concrete_step is True


def test_brief_permits_light_warmth_only_when_not_distressed() -> None:
    message = "هو أنا غبي ولا إيه 😂"
    classification = classify_message(message, locale="auto")

    brief = _service().build_brief(
        user_message=message,
        classification=classification,
        response_mode="normal_support",
    )

    assert brief.social_tone == "light_or_playful"
    assert brief.can_use_light_warmth is True
    assert brief.needs_concrete_step is False


def test_quality_evaluator_flags_generic_support_without_grounding() -> None:
    message = "I cannot sleep after the argument with my brother."
    classification = classify_message(message)
    service = _service()
    brief = service.build_brief(
        user_message=message,
        classification=classification,
        response_mode="normal_support",
    )

    evaluation = service.evaluate(
        user_message=message,
        reply="I'm here for you. That sounds hard.",
        brief=brief,
    )

    assert "generic_without_grounding" in evaluation.issues
    assert "missing_concrete_next_step" in evaluation.issues
    assert evaluation.score < 72
    assert evaluation.repair_recommended is True


def test_quality_evaluator_accepts_grounded_and_actionable_support() -> None:
    message = "I cannot sleep after the argument with my brother."
    classification = classify_message(message)
    service = _service()
    brief = service.build_brief(
        user_message=message,
        classification=classification,
        response_mode="normal_support",
    )

    evaluation = service.evaluate(
        user_message=message,
        reply=(
            "After an argument with your brother, it makes sense your mind is replaying it. "
            "Try writing the one sentence you wish had landed differently, then put the note away for tonight."
        ),
        brief=brief,
    )

    assert evaluation.score == 100
    assert evaluation.issues == ()
    assert evaluation.repair_recommended is False


@pytest.mark.asyncio
async def test_repair_is_used_only_when_it_measurably_improves_a_safe_reply() -> None:
    service = _service(ENABLE_RESPONSE_QUALITY_REPAIR=True)
    brief = ResponseBrief(
        intent="wellbeing_support",
        emotional_state="distressed",
        social_tone="warm_and_steady",
        language_style="match_the_user_language_and_register",
        response_depth="supportive_and_specific",
        directness="balanced",
        needs_concrete_step=True,
        can_use_light_warmth=False,
    )

    async def fake_repair(**_: object) -> tuple[str, str]:
        return (
            "After that argument, your mind may still be trying to finish the conversation. "
            "Write down the one sentence you want to say tomorrow, then take three slow breaths.",
            "test-provider",
        )

    service._repair = fake_repair  # type: ignore[method-assign]
    # A remote provider is required only as a deployment guard; the test replaces the call.
    service.llm_service = object()  # type: ignore[assignment]

    outcome = await service.improve_if_needed(
        user_message="I cannot sleep after arguing with my brother.",
        candidate_reply="I'm here for you. That sounds hard.",
        brief=brief,
        locale="en",
        safety_level="safe",
        request_id="quality-test",
    )

    assert outcome.repaired is True
    assert outcome.repair_provider == "test-provider"
    assert outcome.evaluation.score == 100


@pytest.mark.asyncio
async def test_repair_is_never_attempted_for_elevated_safety() -> None:
    service = _service(ENABLE_RESPONSE_QUALITY_REPAIR=True)
    service.llm_service = object()  # type: ignore[assignment]
    brief = ResponseBrief(
        intent="immediate_safety_support",
        emotional_state="acute_distress",
        social_tone="warm_and_steady",
        language_style="match_the_user_language_and_register",
        response_depth="supportive_and_specific",
        directness="direct",
        needs_concrete_step=False,
        can_use_light_warmth=False,
    )

    outcome = await service.improve_if_needed(
        user_message="I need help now.",
        candidate_reply="I'm here for you.",
        brief=brief,
        locale="en",
        safety_level="high",
        request_id="safety-test",
    )

    assert outcome.repaired is False


def test_tiered_prompt_receives_response_brief_without_weakening_language_rule() -> None:
    classification = classify_message("حاسس إني مضغوط ومش عارف أنام")
    prompt = build_tiered_prompt(
        classification=classification,
        locale="auto",
        response_brief=(
            "TRUSTED CONVERSATION RESPONSE BRIEF:\n"
            "- social_tone=warm_and_steady\n"
            "- language_style=natural_egyptian_arabic"
        ),
    )

    assert "TRUSTED CONVERSATION RESPONSE BRIEF:" in prompt
    assert "ABSOLUTE FINAL RULE — LANGUAGE:" in prompt


@pytest.mark.asyncio
async def test_english_greeting_never_surfaces_arabic_reply_when_locale_is_arabic() -> None:
    """Regression for the reported `hiii` → Arabic greeting production failure."""
    service = _service()
    classification = classify_message("hiii", locale="ar")
    brief = service.build_brief(
        user_message="hiii",
        classification=classification,
        response_mode="normal_support",
    )

    assert brief.expected_output_language == "english"

    outcome = await service.enforce_reply_language(
        candidate_reply="مرحباً. ماذا تريد أن تتكلم عن؟",
        brief=brief,
        locale="ar",
        request_id="english-greeting-language-regression",
    )

    assert outcome.corrected is True
    assert outcome.fallback_used is True
    assert outcome.reply == "Hi — what would you like to talk about?"


@pytest.mark.asyncio
async def test_arabic_greeting_never_surfaces_english_reply() -> None:
    service = _service()
    classification = classify_message("أهلًا", locale="en")
    brief = service.build_brief(
        user_message="أهلًا",
        classification=classification,
        response_mode="normal_support",
    )

    assert brief.expected_output_language == "arabic"

    outcome = await service.enforce_reply_language(
        candidate_reply="Hi — what would you like to talk about?",
        brief=brief,
        locale="en",
        request_id="arabic-greeting-language-regression",
    )

    assert outcome.corrected is True
    assert outcome.fallback_used is True
    assert outcome.reply == "مرحبًا — عن ماذا تريد أن تتحدث؟"


def test_response_brief_current_message_language_beats_client_locale() -> None:
    service = _service()
    classification = classify_message("hiii", locale="ar")
    brief = service.build_brief(
        user_message="hiii",
        classification=classification,
        response_mode="normal_support",
    )

    assert classification.language == "english"
    assert brief.expected_output_language == "english"


@pytest.mark.asyncio
async def test_english_greeting_rejects_transliterated_arabic_lead() -> None:
    """The live `hiii` → `Marhaba` reply must be corrected to natural English."""
    service = _service()
    classification = classify_message("hiii", locale="ar")
    brief = service.build_brief(
        user_message="hiii",
        classification=classification,
        response_mode="normal_support",
    )

    outcome = await service.enforce_reply_language(
        candidate_reply="Marhaba! It's great to hear from you again.",
        brief=brief,
        locale="ar",
        request_id="transliterated-greeting-regression",
    )

    assert outcome.corrected is True
    assert outcome.fallback_used is True
    assert outcome.reply == "Hi — what would you like to talk about?"


def test_quality_evaluator_flags_breathing_after_explicit_user_boundary() -> None:
    message = "Don't just tell me to breathe. I need a practical alternative."
    classification = classify_message(message)
    service = _service()
    brief = service.build_brief(
        user_message=message,
        classification=classification,
        response_mode="normal_support",
    )

    evaluation = service.evaluate(
        user_message=message,
        reply="Break the task into one line, then take a few deep breaths.",
        brief=brief,
    )

    assert brief.prohibited_suggestions == ("breathing_exercises",)
    assert "user_boundary_violated" in evaluation.issues
    assert evaluation.repair_recommended is True


def test_quality_evaluator_flags_invented_continuity_in_new_chat() -> None:
    service = _service()
    classification = classify_message("hiii")
    brief = service.build_brief(
        user_message="hiii",
        classification=classification,
        response_mode="normal_support",
        chat_history=[],
    )

    evaluation = service.evaluate(
        user_message="hiii",
        reply="It's great to hear from you again. How have you been managing your workload lately?",
        brief=brief,
    )

    assert brief.is_new_conversation is True
    assert "unsupported_continuity" in evaluation.issues
    assert evaluation.repair_recommended is True


def test_quality_evaluator_flags_bare_breathing_cliche() -> None:
    message = "Give me a 10-word answer: I'm nervous to call my dad."
    classification = classify_message(message)
    service = _service()
    brief = service.build_brief(
        user_message=message,
        classification=classification,
        response_mode="normal_support",
    )

    evaluation = service.evaluate(
        user_message=message,
        reply="It's normal to feel nervous, take a few deep breaths.",
        brief=brief,
    )

    assert "generic_coping_cliche" in evaluation.issues
