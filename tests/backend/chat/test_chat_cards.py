"""Interactive cards in chat: offered when they help, never in a crisis, never too often."""

import pytest

from backend.domain.chat.cards import choose_card
from backend.domain.chat.contracts import ChatStreamPayload
from backend.domain.chat.orchestrator import ChatOrchestrator
from backend.domain.quota.quota import QuotaService
from backend.domain.sessions.contracts import clipped_messages
from backend.infra.store.store import InMemoryStore
from tests.backend.chat.test_chat_pipeline import RecordingLLM


def kind(message, **kw):
    card = choose_card(message, strategy=kw.pop("strategy", "Active Listen"), **kw)
    return card.kind if card else None


def test_cues_pick_the_right_tool_in_english_and_arabic():
    assert kind("I think I'm having a panic attack, my heart is racing") == "breathing"
    assert kind("عندي نوبة قلق وقلبي يدق") == "breathing"
    assert kind("I'm so overwhelmed, everything at once") == "grounding"
    assert kind("انا مضغوط وكل شي فوق بعض") == "grounding"
    assert kind("I always ruin everything, I'm a total failure at this", strategy="Cognitive Tools") == "thought_record"
    assert kind("still low today", trajectory_direction="heavier", user_turns=5) == "mood_check"
    assert kind("hey, how was your day?") is None


def test_breathing_pattern_follows_the_moment():
    assert choose_card("panic, I can't sleep at all", strategy="Active Listen").pattern == "478"
    assert choose_card("I'm panicking before my exam", strategy="Active Listen").pattern == "box"


def test_never_in_crisis_and_never_too_often():
    assert kind("help me breathe", crisis=True) is None
    assert kind("help me breathe", strategy="Safety Shield") is None
    assert kind("I'm panicking", recent_cards=["", "grounding"]) is None, "a card two replies ago"
    assert kind("I'm panicking", recent_cards=["", "", "", "breathing"]) is None, "same kind too soon"
    assert kind("I'm panicking", recent_cards=["", "", "", "grounding"]) == "breathing"
    assert kind("can we do a breathing exercise?", recent_cards=["breathing"]) == "breathing", "an ask always wins"
    assert kind("ممكن تمرين تنفس؟", recent_cards=["breathing"]) == "breathing"


def test_payload_keeps_only_known_card_kinds():
    payload = ChatStreamPayload(message="hi", recent_cards=["breathing", "<script>", ""])
    assert payload.recent_cards == ["breathing", "", ""]


def test_synced_chats_keep_the_card_and_nothing_else():
    kept = clipped_messages([
        {"role": "assistant", "content": "Let's breathe.", "card": {"kind": "breathing", "id": "card_abc", "pattern": "box", "done": True, "evil": "x"}},
        {"role": "assistant", "content": "ok", "card": {"kind": "unknown"}},
    ])
    assert kept[0]["card"] == {"kind": "breathing", "id": "card_abc", "pattern": "box", "done": True}
    assert "card" not in kept[1]


@pytest.mark.asyncio
async def test_the_card_goes_out_before_the_reply_and_the_model_is_told():
    llm = RecordingLLM()
    orch = ChatOrchestrator(llm_gateway=llm, store=InMemoryStore(), quota_service=QuotaService(InMemoryStore()))
    chunks = [c async for c in orch.execute_turn_stream(
        user_id_hash="usr_cards", message="I'm having a panic attack right now", consume_quota=False, request_id="req_c",
    )]
    first_text = next(i for i, c in enumerate(chunks) if c.get("text"))
    card_at = next(i for i, c in enumerate(chunks) if c.get("card"))
    assert card_at < first_text and chunks[card_at]["card"]["kind"] == "breathing"
    assert "do not write the steps out" in llm.calls[0]["system_instruction"]


@pytest.mark.asyncio
async def test_no_card_when_the_client_just_showed_one():
    llm = RecordingLLM()
    orch = ChatOrchestrator(llm_gateway=llm, store=InMemoryStore(), quota_service=QuotaService(InMemoryStore()))
    chunks = [c async for c in orch.execute_turn_stream(
        user_id_hash="usr_cards2", message="I'm still panicking", consume_quota=False, recent_cards=["breathing"],
    )]
    assert not any(c.get("card") for c in chunks)


def test_a_finished_card_never_brings_itself_back():
    # The result message names its exercise ("I did the breathing exercise"),
    # which read as a fresh ask and showed the same card again.
    for result in (
        "I did the breathing exercise. I feel calmer.",
        "I did the 5-4-3-2-1 grounding. 5 things you can see: my desk.",
        "Thought record\nThe thought: I always mess up",
        "Mood check-in: 2/5 (low), feeling tense.",
        "سويت تمرين التنفس. أحس إني أهدى شوي.",
        "تسجيل المزاج: 2/5 (تعبان).",
    ):
        assert kind(result, recent_cards=["breathing"]) is None, result
        assert kind(result) is None, result


def test_asking_again_right_after_needs_real_asking():
    assert kind("breathing exercise", recent_cards=["breathing"]) is None
    assert kind("can we do the breathing exercise again?", recent_cards=["breathing"]) == "breathing"
    assert kind("ممكن تمرين تنفس مرة ثانية", recent_cards=["breathing"]) == "breathing"
    assert kind("can we do a grounding exercise?", recent_cards=["breathing"]) == "grounding", "a different card is fine"
