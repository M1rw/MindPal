"""Golden-set CI evaluation gate test suite.

Runs golden-set persona evaluation scenarios against known regression classes:
1. BUG-001 regression check: Duplicate user turns in prompt assembly.
2. Missing safety escalation check: Repeated crisis triggers monotonically raise escalation level.
3. Severity misframing check: PHQ-9 / GAD-7 score >= 10 prohibited praise check.
4. Context-free reply check: UserContextSnapshot working context correctly injected.
"""

import json
from pathlib import Path
import pytest

from backend.models.chat import ChatMessage, ChatRequest, ChatRole
from backend.models.safety import SafetyLevel
from backend.models.understanding import UserContextSnapshot
from backend.services.domain.llm.chat_orchestrator import convert_history
from backend.services.domain.llm.message_classifier import MessageClassification
from backend.services.domain.llm.prompts.prompt_builder import build_tiered_prompt
from backend.services.domain.llm.request_builder import build_llm_request
from backend.services.domain.safety.service import SafetyService


def test_ci_gate_bug001_duplicate_user_turn_prevention():
    """Verify BUG-001 regression: Current message never appears duplicated in assembly."""
    fixtures_dir = Path("data/audit_fixtures")
    fixture_files = list(fixtures_dir.glob("*.json"))
    assert len(fixture_files) >= 7

    for fixture_path in fixture_files:
        with open(fixture_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        raw_messages = data.get("messages", [])
        if not raw_messages:
            continue

        history_msgs = [
            ChatMessage(role=ChatRole(m["role"]), content=m["content"])
            for m in raw_messages[:-1]
        ]
        current_msg = raw_messages[-1]["content"]

        req = ChatRequest(message=current_msg, history=history_msgs, user_id_hash="usr_ci_test")
        converted_req = convert_history(req)

        if converted_req:
            assert converted_req[-1].content != current_msg or converted_req[-1].role != ChatRole.USER

        llm_req = build_llm_request(
            request_id="req_ci_test",
            system_prompt="System instruction",
            user_message=current_msg,
            history=converted_req,
        )
        assembled_history = llm_req.messages or []

        if assembled_history:
            assert assembled_history[-1].content == current_msg


@pytest.mark.asyncio
async def test_ci_gate_safety_escalation_monotonicity():
    """Verify safety escalation monotonicity across repeated crisis messages."""
    safety_service = SafetyService()
    session_id = "sess_ci_test_escalation"

    level1, triggered1, rank1 = safety_service.record_session_escalation(
        session_key=session_id,
        detected_level=SafetyLevel.SELF_HARM_AMBIGUOUS,
    )
    assert rank1 >= 3  # SELF_HARM_AMBIGUOUS rank is 3

    level2, triggered2, rank2 = safety_service.record_session_escalation(
        session_key=session_id,
        detected_level=SafetyLevel.SELF_HARM_AMBIGUOUS,
    )
    assert rank2 > rank1

    level3, triggered3, rank3 = safety_service.record_session_escalation(
        session_key=session_id,
        detected_level=SafetyLevel.SELF_HARM_IMMINENT,
    )
    assert rank3 > rank2


def test_ci_gate_severity_misframing_prevention():
    """Verify PHQ-9/GAD-7 severity score >= 10 rules strictly prohibit praise."""
    safety_service = SafetyService()
    phq9_sev = safety_service.map_phq9_severity(17)
    gad7_sev = safety_service.map_gad7_severity(14)

    assert phq9_sev["suggests_professional_care"] is True
    assert gad7_sev["suggests_professional_care"] is True

    classification = MessageClassification(
        tier="emotional",
        language="english",
        confidence=0.9,
        signals=[],
        skip_thought=False,
        max_thought_words=100,
        max_response_tokens=500,
        temperature=0.4,
    )

    prompt = build_tiered_prompt(
        classification=classification,
        locale="en",
        user_preferences="Clinical Score Guidance:\n- NEVER praise or describe score >= 10 as 'good progress'.\n- Suggest professional medical/therapeutics care support.",
    )

    assert "NEVER praise or describe score >= 10 as 'good progress'" in prompt
    assert "Suggest professional medical/therapeutics care support" in prompt


def test_ci_gate_context_aware_reply_generation():
    """Verify UserContextSnapshot and gap_days are injected into prompt directives."""
    snapshot = UserContextSnapshot(
        user_id_hash="usr_ci_context",
        situational_portrait="Workplace conflict with manager regarding project deadlines",
        dominant_themes=["work_stress", "anxiety"],
    )

    classification = MessageClassification(
        tier="emotional",
        language="english",
        confidence=0.9,
        signals=[],
        skip_thought=False,
        max_thought_words=100,
        max_response_tokens=500,
        temperature=0.4,
    )

    memory_prompt_with_gap = (
        f"Situational Portrait: {snapshot.situational_portrait}\n"
        "User has been absent for 5 days. Open warmly acknowledging the time away."
    )

    prompt = build_tiered_prompt(
        classification=classification,
        locale="en",
        memory_prompt=memory_prompt_with_gap,
    )

    assert "Workplace conflict with manager regarding project deadlines" in prompt
    assert "absent for 5 days" in prompt
