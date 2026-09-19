# tests/unit/platform/test_voice_safety_lexicon.py — ASR-shaped crisis detection
#
# The live voice channel feeds the classifier raw ASR output: lowercase, no
# punctuation, no apostrophes, and words split in places a writer never would.
# These cases are the shapes that actually arrive, plus the ordinary speech that
# must not stop a call. Shared with the client mirror via the JSON corpus.

from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.domain.safety.classify import (
    CRISIS_RESPONSE,
    SafetyService,
    crisis_evidence,
    normalize_for_safety,
)

CORPUS = json.loads(
    (Path(__file__).resolve().parents[2] / "fixtures" / "voice_crisis_phrases.json").read_text(
        encoding="utf-8"
    )
)


@pytest.mark.parametrize("phrase", CORPUS["crisis"])
def test_asr_shaped_disclosures_are_caught(phrase: str) -> None:
    assert crisis_evidence(phrase), f"missed disclosure: {phrase}"


@pytest.mark.parametrize("phrase", CORPUS["ordinary"])
def test_ordinary_speech_does_not_freeze_a_call(phrase: str) -> None:
    assert crisis_evidence(phrase) is None, f"false positive: {phrase}"


def test_spacing_and_apostrophe_variants_match_the_same_way() -> None:
    for variant in ("kill myself", "kill my self", "killing my self", "I'll kill my self"):
        assert crisis_evidence(variant), variant
    for variant in ("i dont want to live", "i don't want to live", "i do not want to live"):
        assert crisis_evidence(variant), variant


def test_punctuated_prose_still_matches_after_normalization() -> None:
    assert normalize_for_safety("I don't want to LIVE, anymore!!") == "i dont want to live anymore"
    assert crisis_evidence("I don't want to live, anymore!!")


def test_no_single_delta_matches_but_the_cumulative_transcript_does() -> None:
    for deltas in CORPUS["split_deltas"]:
        assert all(crisis_evidence(delta) is None for delta in deltas), deltas
        assert crisis_evidence("".join(deltas)), deltas


def test_arabic_folding_survives_alef_and_ya_variants() -> None:
    assert crisis_evidence("أبي أموت")
    assert crisis_evidence("بدى اموت")
    # "نفسيتي" (my mood) only prefixes "نفسي" (myself); it is not a disclosure.
    assert crisis_evidence("الشغل بيقتل نفسيتي") is None


def test_referral_phrasing_is_not_a_disclosure() -> None:
    """Keeps the model's own safe handoff from tripping the output-side check."""
    assert crisis_evidence("call the suicide and crisis lifeline on 988") is None
    assert crisis_evidence("the suicide hotline helped me") is None


def test_classify_message_reports_evidence_without_claiming_clinical_judgement() -> None:
    result = SafetyService().classify_message("i want to kill my self")
    assert result.is_crisis is True
    assert result.risk_level == "imminent"
    assert result.trigger_reason == "kill my self"
    assert result.crisis_response == CRISIS_RESPONSE
    assert "988" in CRISIS_RESPONSE

    calm = SafetyService().classify_message("work has been really heavy lately")
    assert calm.is_crisis is False
    assert calm.crisis_response is None
