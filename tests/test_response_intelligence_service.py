from __future__ import annotations

from types import SimpleNamespace

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


def test_active_listener_brief_includes_human_reply_orchestration() -> None:
    message = "I want money fast, but I still have three years of college left."
    classification = classify_message(message)
    brief = _service().build_brief(
        user_message=message,
        classification=classification,
        response_mode="normal_support",
        metadata=SimpleNamespace(mode="active_listen"),
    )

    assert brief.communication_style == "active_listener"
    assert brief.needs_concrete_step is False
    assert "HUMAN REPLY ORCHESTRATION:" in brief.to_prompt()
    assert "ACTIVE LISTEN:" in brief.to_prompt()
    assert "response_move=" in brief.to_prompt()
    assert "target_shape=" in brief.to_prompt()


def test_hro_selects_distinct_moves_and_shapes_per_mode() -> None:
    message = "I’m building a lot but it feels like I build air."
    classification = classify_message(message)
    service = _service()

    active = service.build_brief(
        user_message=message,
        classification=classification,
        response_mode="normal_support",
        metadata=SimpleNamespace(mode="active_listen"),
    )
    coach = service.build_brief(
        user_message=message,
        classification=classification,
        response_mode="normal_support",
        metadata=SimpleNamespace(mode="guided_coach"),
    )
    cognitive = service.build_brief(
        user_message=message,
        classification=classification,
        response_mode="normal_support",
        metadata=SimpleNamespace(mode="cognitive_tools"),
    )

    assert (active.communication_style, active.response_move, active.target_shape) == (
        "active_listener", "meaning_making", "short_prose"
    )
    assert (coach.communication_style, coach.response_move, coach.target_shape) == (
        "guided_coach", "meaning_making", "short_prose"
    )
    assert (cognitive.communication_style, cognitive.response_move, cognitive.target_shape) == (
        "cognitive_tools", "meaning_making", "short_prose"
    )


def test_guided_coach_selects_diagnostic_fork_before_a_plan() -> None:
    message = "My project is not moving and I don’t know why."
    classification = classify_message(message)
    brief = _service().build_brief(
        user_message=message,
        classification=classification,
        response_mode="normal_support",
        metadata=SimpleNamespace(mode="guided_coach"),
    )

    assert brief.response_move == "diagnostic_fork"
    assert brief.target_shape == "short_prose"


def test_active_listener_rejects_live_literal_mirroring_failure() -> None:
    message = "I’m building a lot but it feels like I build air."
    classification = classify_message(message)
    service = _service()
    brief = service.build_brief(
        user_message=message,
        classification=classification,
        response_mode="normal_support",
        metadata=SimpleNamespace(mode="active_listen"),
    )

    evaluation = service.evaluate(
        user_message=message,
        reply=(
            "You're building a lot, but it feels like you're building air. "
            "That's a really interesting phrase—what does building air mean to you in this context?"
        ),
        brief=brief,
    )

    assert "literal_mirroring" in evaluation.issues
    assert "robotic_reflection_template" in evaluation.issues
    assert evaluation.repair_recommended is True


def test_active_listener_rejects_ungrounded_metaphor_reframe() -> None:
    message = "I’m building a lot but it feels like I build air."
    classification = classify_message(message)
    service = _service()
    brief = service.build_brief(
        user_message=message,
        classification=classification,
        response_mode="normal_support",
        metadata=SimpleNamespace(mode="active_listen"),
    )

    evaluation = service.evaluate(
        user_message=message,
        reply=(
            "You're putting in a lot of effort to build something, but it doesn't feel substantial. "
            "Maybe the act of building itself is what's important, rather than just the end result. "
            "What kind of things are you trying to build?"
        ),
        brief=brief,
    )

    assert "ungrounded_metaphor_reframe" in evaluation.issues
    assert evaluation.repair_recommended is True


def test_active_listener_requires_concrete_metaphor_evidence_fork() -> None:
    message = "I’m building a lot but it feels like I build air."
    classification = classify_message(message)
    service = _service()
    brief = service.build_brief(
        user_message=message,
        classification=classification,
        response_mode="normal_support",
        metadata=SimpleNamespace(mode="active_listen"),
    )

    broad_reframe = service.evaluate(
        user_message=message,
        reply=(
            "You're putting a lot of effort into building something, but it doesn't feel like "
            "it's amounting to much. Maybe the things you're creating aren't having the impact "
            "or getting the reaction you expected. What kind of projects are you working on?"
        ),
        brief=brief,
    )
    evidence_fork = service.evaluate(
        user_message=message,
        reply=(
            "‘Building air’ can mean the work is not becoming a finished version, getting outside "
            "feedback, or producing a result you can measure. Which is closest?"
        ),
        brief=brief,
    )
    natural_evidence_fork = service.evaluate(
        user_message=message,
        reply=(
            "Maybe what you're building is missing a tangible outcome, a meaningful response from "
            "others, or a sense of completion — which one resonates with you?"
        ),
        brief=brief,
    )

    assert "ungrounded_metaphor_reframe" in broad_reframe.issues
    assert broad_reframe.repair_recommended is True
    assert evidence_fork.score == 100
    assert evidence_fork.issues == ()
    assert natural_evidence_fork.score == 100
    assert natural_evidence_fork.issues == ()


def test_guided_coach_rejects_premature_generic_checklist() -> None:
    message = "My project is not moving and I don’t know why."
    classification = classify_message(message)
    service = _service()
    brief = service.build_brief(
        user_message=message,
        classification=classification,
        response_mode="normal_support",
        metadata=SimpleNamespace(mode="guided_coach"),
    )

    evaluation = service.evaluate(
        user_message=message,
        reply=(
            "Break down your goals into smaller, more manageable tasks. "
            "Identify the most important task and focus on one task at a time. Take regular breaks."
        ),
        brief=brief,
    )

    assert "premature_generic_plan" in evaluation.issues
    assert evaluation.repair_recommended is True


def test_guided_coach_rejects_live_ungrounded_cause_and_generic_plan() -> None:
    message = "My project is not moving and I don’t know why."
    classification = classify_message(message)
    service = _service()
    brief = service.build_brief(
        user_message=message,
        classification=classification,
        response_mode="normal_support",
        metadata=SimpleNamespace(mode="guided_coach"),
    )

    evaluation = service.evaluate(
        user_message=message,
        reply=(
            "One possibility is that you're overthinking or overplanning, which can lead to analysis paralysis. "
            "Try breaking down your project into smaller, manageable tasks. Focus on completing one task at a time. "
            "Make a list of the tasks that need to be done, prioritize the most important tasks, and set specific, achievable goals."
        ),
        brief=brief,
    )

    assert "premature_generic_plan" in evaluation.issues
    assert "robotic_reflection_template" not in evaluation.issues
    assert evaluation.repair_recommended is True


def test_pro_style_rejects_prior_assistant_hypothesis_as_user_history() -> None:
    message = "I’m building a lot but it feels like I build air."
    classification = classify_message(message)
    service = _service()
    brief = service.build_brief(
        user_message=message,
        classification=classification,
        response_mode="normal_support",
        metadata=SimpleNamespace(mode="guided_coach"),
        chat_history=[SimpleNamespace(role="assistant", content="You may be disconnected from your goals.")],
    )

    evaluation = service.evaluate(
        user_message=message,
        reply=(
            "Earlier you said you were feeling disconnected from your goals or motivations. "
            "It may help to focus on a different metric."
        ),
        brief=brief,
    )

    assert "unsupported_assistant_hypothesis" in evaluation.issues
    assert evaluation.repair_recommended is True


def test_active_listener_rejects_robotic_reflection_and_generic_question_loop() -> None:
    message = "I want money fast, but I still have three years of college left."
    classification = classify_message(message)
    service = _service()
    brief = service.build_brief(
        user_message=message,
        classification=classification,
        response_mode="normal_support",
        metadata=SimpleNamespace(mode="active_listen"),
    )

    evaluation = service.evaluate(
        user_message=message,
        reply=(
            "It seems like you are under pressure. One possibility is that you need more options. "
            "What do you think is the most pressing issue right now?"
        ),
        brief=brief,
    )

    assert "robotic_reflection_template" in evaluation.issues
    assert "generic_question_loop" in evaluation.issues
    assert evaluation.score < 72
    assert evaluation.repair_recommended is True


def test_active_listener_rejects_live_paraphrase_and_generic_options_failure() -> None:
    message = "I want money fast, but I still have three years of college left and I don’t want to waste them only working. I honestly don’t know what to do next."
    classification = classify_message(message)
    service = _service()
    brief = service.build_brief(
        user_message=message,
        classification=classification,
        response_mode="normal_support",
        metadata=SimpleNamespace(mode="active_listen"),
    )

    evaluation = service.evaluate(
        user_message=message,
        reply=(
            "You're trying to balance earning money quickly with finishing your last three years of college without wasting them on just working. "
            "You could explore ways to earn money that fit around your studies, like part-time jobs, freelancing, or online sales. "
            "What's the most important thing you'd want from a part-time job or side hustle to make it worth your time?"
        ),
        brief=brief,
    )

    assert "generic_question_loop" in evaluation.issues
    assert "vacuous_restatement" in evaluation.issues
    assert evaluation.score < 72
    assert evaluation.repair_recommended is True


def test_active_listener_requires_a_bounded_decision_contribution() -> None:
    message = "I want money fast, but I still have three years of college left and I don’t want to waste them only working. I honestly don’t know what to do next."
    classification = classify_message(message)
    service = _service()
    brief = service.build_brief(
        user_message=message,
        classification=classification,
        response_mode="normal_support",
        metadata=SimpleNamespace(mode="active_listen"),
    )

    evaluation = service.evaluate(
        user_message=message,
        reply=(
            "You're in a tough spot with three years of college left and a need for money. "
            "Not wanting to waste your college time just working is a valid concern. "
            "What's the most important thing you feel is missing from your current situation that having more money would solve?"
        ),
        brief=brief,
    )

    assert "robotic_reflection_template" in evaluation.issues
    assert "missing_decision_contribution" in evaluation.issues
    assert evaluation.score < 72
    assert evaluation.repair_recommended is True


def test_active_listener_accepts_bounded_default_move_for_direct_decision_request() -> None:
    message = "I want money fast, but I still have three years of college left and I don’t want to waste them only working. I honestly don’t know what to do next."
    classification = classify_message(message)
    service = _service()
    brief = service.build_brief(
        user_message=message,
        classification=classification,
        response_mode="normal_support",
        metadata=SimpleNamespace(mode="active_listen"),
    )

    evaluation = service.evaluate(
        user_message=message,
        reply=(
            "Treat the next two weeks as a small test, not a decision about your whole college life. "
            "Today, choose one skill you can offer and cap the work at five hours a week; by the end of the test, you will know whether people will pay for it without giving up your studies."
        ),
        brief=brief,
    )

    assert evaluation.score == 100
    assert evaluation.issues == ()


def test_active_listener_accepts_specific_decision_frame_without_a_template() -> None:
    message = "I want money fast, but I still have three years of college left."
    classification = classify_message(message)
    service = _service()
    brief = service.build_brief(
        user_message=message,
        classification=classification,
        response_mode="normal_support",
        metadata=SimpleNamespace(mode="active_listen"),
    )

    evaluation = service.evaluate(
        user_message=message,
        reply=(
            "With three college years left, protect your study time while you test income. "
            "What skill could you try this month in five hours a week or less?"
        ),
        brief=brief,
    )

    assert evaluation.score == 100
    assert evaluation.issues == ()


def test_tiered_prompt_carries_human_reply_orchestration_contract() -> None:
    message = "I want money fast, but I still have three years of college left."
    classification = classify_message(message)
    brief = _service().build_brief(
        user_message=message,
        classification=classification,
        response_mode="normal_support",
        metadata=SimpleNamespace(mode="active_listen"),
    )

    prompt = build_tiered_prompt(
        classification=classification,
        locale="auto",
        response_mode="normal_support",
        response_brief=brief.to_prompt(),
    )

    assert "HUMAN REPLY ORCHESTRATION:" in prompt
    assert "ACTIVE LISTEN:" in prompt
    assert "response_move=" in prompt
    assert "ABSOLUTE FINAL RULE — LANGUAGE:" in prompt


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
