# tests/test_greeting_engine.py
"""
Unit tests for the Smart Contextual Greeting Engine.
Covers:
- Time period resolution & salutations
- Timezone offset handling
- Return gap buckets (new user, <2h, 2h-24h, 1-7 days, >7 days)
- 2-layer caching (store hit/miss)
- Specificity scoring & sensitivity hard-blocks
- Telemetry feedback loop
- System load shedding
"""

import pytest
from datetime import datetime, timezone, timedelta
from backend.domain.greeting.engine import (
    GreetingEngine,
    _get_time_period,
    _compute_specificity_score,
    _heuristic_greeting,
)
from backend.infra.store.store import get_store


@pytest.fixture
def store():
    return get_store()


@pytest.fixture
def engine(store):
    return GreetingEngine()


def test_time_period_resolution():
    assert _get_time_period(6) == "morning"
    assert _get_time_period(11) == "morning"
    assert _get_time_period(12) == "afternoon"
    assert _get_time_period(16) == "afternoon"
    assert _get_time_period(17) == "evening"
    assert _get_time_period(21) == "evening"
    assert _get_time_period(22) == "night"
    assert _get_time_period(3) == "night"


def test_heuristic_greeting_buckets():
    # New user
    assert _heuristic_greeting("Miljte", 9, None, is_new_user=True) == "Good morning, Miljte."
    
    # Return gap < 2h (7200s)
    assert _heuristic_greeting("Miljte", 14, 1800, is_new_user=False) == "Welcome back, Miljte."

    # Return gap 2h - 24h
    assert _heuristic_greeting("Miljte", 19, 36000, is_new_user=False) == "Good evening, Miljte."

    # Return gap 1 - 7 days (e.g. 3 days = 259200s)
    g3 = _heuristic_greeting("Miljte", 9, 259200, is_new_user=False)
    assert "Good to see you again, Miljte" in g3

    # Return gap > 7 days (e.g. 10 days = 864000s)
    g10 = _heuristic_greeting("Miljte", 9, 864000, is_new_user=False)
    assert "It’s been a while, Miljte" in g10 or "It's been a while, Miljte" in g10


def test_specificity_sensitivity_hard_block():
    # Sensitive topics must yield -999 hard block to prevent inappropriate callbacks
    score_crisis = _compute_specificity_score(
        gap_seconds=100000,
        memory_atom_count=10,
        memory_topics=["crisis", "goal"],
        telemetry={"last_greeting_engaged": True},
        system_load_ok=True,
        is_first_visit_this_week=True,
    )
    assert score_crisis == -999

    score_trauma = _compute_specificity_score(
        gap_seconds=100000,
        memory_atom_count=8,
        memory_topics=["trauma"],
        telemetry=None,
        system_load_ok=True,
        is_first_visit_this_week=False,
    )
    assert score_trauma == -999


def test_system_load_shedding():
    score_high_load = _compute_specificity_score(
        gap_seconds=100000,
        memory_atom_count=10,
        memory_topics=["goal", "growth"],
        telemetry=None,
        system_load_ok=False,
        is_first_visit_this_week=True,
    )
    assert score_high_load == -999


def test_telemetry_feedback_scoring():
    # Engaged user scores higher
    score_engaged = _compute_specificity_score(
        gap_seconds=100000,
        memory_atom_count=6,
        memory_topics=["growth"],
        telemetry={"last_greeting_engaged": True},
        system_load_ok=True,
        is_first_visit_this_week=False,
    )
    # Ignored user gets adaptive penalty
    score_ignored = _compute_specificity_score(
        gap_seconds=100000,
        memory_atom_count=6,
        memory_topics=["growth"],
        telemetry={"last_greeting_ignored": True},
        system_load_ok=True,
        is_first_visit_this_week=False,
    )
    assert score_engaged > score_ignored
    assert score_engaged - score_ignored == 4  # +2 vs -2


def test_greeting_engine_caching(engine, store):
    uid = "test_user_cache_abc"
    res1 = engine.get_greeting(
        user_id_hash=uid,
        display_name="Alex",
        tz_offset_minutes=180,  # UTC+3
        memory_summary="Working through career goals.",
        memory_atoms=[{"category": "goal", "value": "New job"}],
    )
    assert res1["cached"] is False
    assert "Alex" in res1["greeting"]

    # Immediate second call must hit the store cache
    res2 = engine.get_greeting(
        user_id_hash=uid,
        display_name="Alex",
        tz_offset_minutes=180,
    )
    assert res2["cached"] is True
    assert res2["greeting"] == res1["greeting"]
