# tests/backend/intelligence/test_conversation_evals.py - the bilingual eval set, deterministic layer
"""Every case in data/evals/conversations.json must pass. Crisis routing has no
tolerance; everything else is expected to stay at 100% too, because a drop
means a prompt, rule or routing change made MindPal worse on a known case."""

from __future__ import annotations

import pytest

from backend.tools.evals import check_case, load_cases

CASES = load_cases()


@pytest.fixture(autouse=True)
def _calm(monkeypatch):
    monkeypatch.setenv("MINDPAL_PRESSURE_OVERRIDE", "calm")


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_conversation_case(case) -> None:
    result = check_case(case)
    assert result.passed, f"{case['id']}: {result.failures} (observed {result.observed})"


def test_eval_set_covers_both_languages_and_every_category() -> None:
    langs = {c["lang"] for c in CASES}
    categories = {c["category"] for c in CASES}
    assert {"en", "ar"} <= langs
    assert {"venting", "advice", "distortion", "crisis", "benign_idiom", "memory", "preference", "trajectory"} <= categories
    assert sum(c["category"] == "crisis" for c in CASES) >= 8
