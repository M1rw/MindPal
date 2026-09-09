# tests/unit/domain/test_safety_domain.py

import pytest

from backend.models.safety import SafetyAction, SafetyLevel
from backend.services.domain.safety import SafetyService


def test_safety_service_deterministic_crisis_classification():
    service = SafetyService()

    # Imminent crisis input
    decision = service.classify_input("I want to kill myself right now", locale="en")
    assert decision.level == SafetyLevel.SELF_HARM_IMMINENT
    assert decision.bypass_llm is True
    assert decision.action == SafetyAction.DETERMINISTIC_RESPONSE
    assert decision.should_log is True

    # Safe input
    safe_decision = service.classify_input("What is the capital of France?", locale="en")
    assert safe_decision.level == SafetyLevel.SAFE
    assert safe_decision.bypass_llm is False


def test_safety_service_rendering_response():
    service = SafetyService()
    decision = service.classify_input("I want to end my life", locale="en")
    response_text = service.render_deterministic_response(decision, locale="en")
    assert len(response_text) > 0


import time

from backend.services.output_guard_service import OutputGuardService


@pytest.mark.asyncio
async def test_output_safety_gate_fault_injection(caplog):
    guard = OutputGuardService()

    # Fault 1: High PHQ-9 score praised as progress
    violating_score_praise = "Your PHQ-9 score of 17 shows great clinical progress! Well done!"
    res1 = await guard.validate_output_with_rewrite(violating_score_praise, locale="en")
    assert res1.is_safe is False
    assert res1.action == "block_and_fallback"
    assert "output_score_praise_high_en" in res1.matched_rules
    assert any(m.category == "forbidden_score_praise" for m in res1.matches)
    assert "great clinical progress" not in res1.final_text
    assert "safety_gate_rejection" in caplog.text

    # Fault 2: PII / Secret key leakage
    violating_pii = "Here is your API token: sk_live_TESTONLY_000000000000000000000000"
    res2 = await guard.validate_output_with_rewrite(violating_pii, locale="en")
    assert res2.is_safe is False
    assert res2.action == "block_and_fallback"
    assert "output_pii_leakage_en" in res2.matched_rules
    assert any(m.category == "pii_leakage" for m in res2.matches)
    assert "sk_live" not in res2.final_text

    # Fault 3: Medication dosing instruction
    violating_meds = "You should start take 50mg of Sertraline every morning."
    res3 = await guard.validate_output_with_rewrite(violating_meds, locale="en")
    assert res3.is_safe is False
    assert res3.action == "block_and_fallback"
    assert "output_medication_dosing_en" in res3.matched_rules
    assert any(m.category == "medication_instruction" for m in res3.matches)
    assert "50mg" not in res3.final_text

    # Safe text passes 100%
    safe_text = "I hear that you're feeling overwhelmed today. Let's take a slow breath together."
    res_safe = await guard.validate_output_with_rewrite(safe_text, locale="en")
    assert res_safe.is_safe is True
    assert res_safe.final_text == safe_text


@pytest.mark.asyncio
async def test_output_safety_gate_latency_overhead():
    guard = OutputGuardService()
    text = "I hear that you are going through a difficult time right now. What is one small step we can take?"

    start = time.perf_counter()
    for _ in range(50):
        await guard.validate_output_with_rewrite(text, locale="en")
    elapsed_ms = ((time.perf_counter() - start) / 50) * 1000

    assert elapsed_ms < 5.0, f"Average gate latency {elapsed_ms:.2f}ms exceeded 5ms limit"


def test_session_escalation_and_operator_dispatch(caplog):
    service = SafetyService()

    # Monotonic escalation: SAFE -> SUPPORTIVE -> SELF_HARM_AMBIGUOUS -> IMMINENT
    session_key = "usr_123:session_1"
    
    lvl1, triggered1, rank1 = service.record_session_escalation(session_key, SafetyLevel.SAFE)
    assert lvl1 == SafetyLevel.SAFE
    assert triggered1 is False
    assert rank1 == 0

    lvl2, triggered2, rank2 = service.record_session_escalation(session_key, SafetyLevel.SELF_HARM_AMBIGUOUS)
    assert lvl2 == SafetyLevel.SELF_HARM_AMBIGUOUS
    assert triggered2 is True
    assert rank2 == 3

    # Consecutive ambiguous crisis messages escalate rank from 3 to 4 (ABUSE_OR_VIOLENCE level)
    lvl3, triggered3, rank3 = service.record_session_escalation(session_key, SafetyLevel.SELF_HARM_AMBIGUOUS)
    assert lvl3 == SafetyLevel.ABUSE_OR_VIOLENCE
    assert triggered3 is True
    assert rank3 == 4

    # Safe message mid-session does not reset escalation level
    lvl4, triggered4, rank4 = service.record_session_escalation(session_key, SafetyLevel.SAFE)
    assert lvl4 == SafetyLevel.ABUSE_OR_VIOLENCE
    assert triggered4 is False
    assert rank4 == 4

    assert "EscalationTriggered" in caplog.text


def test_screening_severity_mapper_and_prompt_framing():
    service = SafetyService()

    # PHQ-9 severity bands
    assert service.map_phq9_severity(3)["band"] == "minimal"
    assert service.map_phq9_severity(3)["suggests_professional_care"] is False

    assert service.map_phq9_severity(8)["band"] == "mild"
    assert service.map_phq9_severity(8)["suggests_professional_care"] is False

    assert service.map_phq9_severity(12)["band"] == "moderate"
    assert service.map_phq9_severity(12)["suggests_professional_care"] is True

    assert service.map_phq9_severity(17)["band"] == "moderately_severe"
    assert service.map_phq9_severity(17)["suggests_professional_care"] is True

    assert service.map_phq9_severity(24)["band"] == "severe"
    assert service.map_phq9_severity(24)["suggests_professional_care"] is True

    # GAD-7 severity bands
    assert service.map_gad7_severity(2)["band"] == "minimal"
    assert service.map_gad7_severity(7)["band"] == "mild"
    assert service.map_gad7_severity(12)["band"] == "moderate"
    assert service.map_gad7_severity(18)["band"] == "severe"


def test_acute_anxiety_panic_pattern_classification():
    service = SafetyService()

    # English chest tightness / acute panic
    decision_en = service.classify_input("My chest feels tight and heavy", locale="en")
    assert decision_en.level == SafetyLevel.SELF_HARM_AMBIGUOUS
    assert decision_en.user_visible_category == "acute_anxiety_grounding"

    # Arabic chest tightness / acute panic
    decision_ar = service.classify_input("صدري مطبوق ومقبوض ومش قادر اتنفس بقالي 30 دقيقة", locale="ar")
    assert decision_ar.level == SafetyLevel.SELF_HARM_AMBIGUOUS
    assert decision_ar.user_visible_category == "acute_anxiety_grounding"
