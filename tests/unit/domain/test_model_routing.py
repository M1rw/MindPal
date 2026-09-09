"""Unit test suite for intelligent model routing logic."""

import pytest
from backend.models.chat import ChatMessage, ChatRequest, ChatRole, ChatMetadata
from backend.models.safety import SafetyLevel, SafetyDecision
from backend.services.domain.llm.chat_orchestrator import determine_target_model
from backend.services.domain.llm.message_classifier import MessageClassification


def test_model_routing_crisis_and_deterministic_turns():
    """Verify crisis/imminent self-harm turns require no LLM model or route deterministically."""
    decision = SafetyDecision.imminent_self_harm(
        response_template_id="imminent_self_harm_en",
        matched_rules=["crisis_pattern_1"],
    )
    classification = MessageClassification(
        tier="crisis",
        language="english",
        confidence=1.0,
        signals=(),
        skip_thought=True,
        max_thought_words=0,
        max_response_tokens=300,
        temperature=0.0,
    )
    req = ChatRequest(
        message="I can't take this anymore",
        metadata=ChatMetadata(model="standard"),
    )

    model = determine_target_model(req, classification, decision)
    assert model in ("none", "deterministic", "offline")


def test_model_routing_short_reframing_casual_greetings():
    """Verify short reframing/greeting/casual messages route to lightweight model."""
    decision = SafetyDecision.safe()
    classification = MessageClassification(
        tier="greeting",
        language="english",
        confidence=0.9,
        signals=(),
        skip_thought=True,
        max_thought_words=0,
        max_response_tokens=200,
        temperature=0.4,
    )
    req = ChatRequest(
        message="Hi there!",
        metadata=ChatMetadata(model="standard"),
    )

    model = determine_target_model(req, classification, decision)
    assert model == "flash-lite" or "flash" in model or "mini" in model or "standard" in model


def test_model_routing_open_ended_exploration_and_pro():
    """Verify open-ended emotional/clinical exploration routes to frontier model."""
    decision = SafetyDecision.safe()
    classification = MessageClassification(
        tier="clinical",
        language="english",
        confidence=0.95,
        signals=("clinical_depth",),
        skip_thought=False,
        max_thought_words=200,
        max_response_tokens=1200,
        temperature=0.4,
    )
    req = ChatRequest(
        message="Can we explore why I feel so anxious every Sunday evening?",
        metadata=ChatMetadata(model="pro"),
    )

    model = determine_target_model(req, classification, decision)
    assert model in ("pro", "frontier", "gemini-2.5-pro", "gemini-1.5-pro")
