import pytest
from backend.domain.chat.orchestrator import detect_cognitive_strategy, ChatOrchestrator


def test_detect_cognitive_strategy_pro():
    strategy, directive = detect_cognitive_strategy("I am feeling fine", model="pro")
    assert strategy == "Thorough"
    assert "complete, well-organized reply" in directive
    assert "clinical" not in directive.lower()
    assert "therapeutic" not in directive.lower()


def test_detect_cognitive_strategy_distress():
    strategy, directive = detect_cognitive_strategy("I am so overwhelmed and anxious today", model="standard")
    assert strategy == "Active Listen"
    assert "Active Empathetic Reflection" in directive


def test_detect_cognitive_strategy_distortion():
    strategy, directive = detect_cognitive_strategy("I always fail at everything, I am worthless", model="standard")
    assert strategy == "Cognitive Tools"
    assert "Cognitive Tools" in directive


def test_detect_cognitive_strategy_coaching():
    strategy, directive = detect_cognitive_strategy("What should I do to fix my routine?", model="standard")
    assert strategy == "Guided Coach"
    assert "Guided Solution Coaching" in directive


def test_detect_cognitive_strategy_telemetry_hesitation():
    telemetry = {
        "inactivity_count": 3,
        "last_idle_duration_seconds": 65,
    }
    strategy, directive = detect_cognitive_strategy("I guess so", model="standard", telemetry=telemetry)
    assert "hesitation/idle periods" in directive
    assert "gentle pacing" in directive


def test_session_telemetry_recording():
    orch = ChatOrchestrator()
    orch.record_session_telemetry("usr_test", "sess_123", {
        "inactivity_count": 2,
        "active_duration_seconds": 120,
        "total_idle_seconds": 45,
    })
    doc = orch.store.get_document("session_telemetry", "usr_test:sess_123")
    assert doc is not None
    assert doc["inactivity_count"] == 2
    assert doc["turns"] == 1
