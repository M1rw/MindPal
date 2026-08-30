# tests/unit/domain/test_safety_domain.py

import pytest
from backend.models.safety import SafetyLevel, SafetyAction
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
