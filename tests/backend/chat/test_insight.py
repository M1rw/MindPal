"""The insight planner: which useful thing a reply adds, and how it learns."""

from __future__ import annotations

import asyncio

import pytest

from backend.domain.adaptation.profile import AdaptiveProfileService, empty_profile, learn_from_message
from backend.domain.chat.insight import learned_move_bias, plan_insight
from backend.domain.chat.orchestrator import ChatOrchestrator
from backend.domain.quota.quota import QuotaService
from backend.infra.store.store import InMemoryStore


@pytest.mark.parametrize(
    ("message", "move", "hook"),
    [
        ("hi", "", ""),
        ("thanks!", "", ""),
        ("I feel stuck", "sharpen", '"stuck"'),
        ("I always mess everything up at work", "test_absolute", '"always"'),
        ("I'm so stupid, I forgot her birthday again", "self_kindness", '"i\'m so stupid"'),
        ("I should be further along by now", "unpack_should", '"should"'),
        ("I'm happy for her but part of me feels left behind", "name_tension", ""),
        ("I finally passed my driving test!!", "savor", '"finally"'),
        ("How many hours of sleep do adults actually need?", "answer", ""),
        ("what should I do about my manager taking credit for my work?", "micro_step", ""),
        ("انا فاشل وكل شي اخربه", "self_kindness", '"انا فاشل"'),
        ("لازم اخلص كل شي قبل الاسبوع الجاي", "unpack_should", '"لازم"'),
        ("اخيرا تخرجت!", "savor", '"اخيرا"'),
        ("مدري، حاسس اني ضايع", "sharpen", '"مدري"'),
    ],
)
def test_the_move_fits_the_message_and_quotes_their_words(message: str, move: str, hook: str) -> None:
    plan = plan_insight(message)
    assert plan.move == move
    if hook:
        assert plan.hook == hook and hook in plan.note


def test_context_moves_use_recurring_topics_memory_and_venting_loops() -> None:
    assert plan_insight("still thinking about the exam", recurring=["exam"]).move == "connect_thread"
    memory = "Things they shared:\n- Has a job interview at a bank on Friday"
    plan = plan_insight("the interview is tomorrow", memory_text=memory)
    assert plan.move == "memory_callback" and "bank" in plan.note
    loop = [
        {"role": "user", "content": "my breakup still hurts so much"},
        {"role": "assistant", "content": "What part hurts most?"},
        {"role": "user", "content": "everything about it honestly"},
        {"role": "assistant", "content": "What do you miss?"},
        {"role": "user", "content": "the way we used to talk every night"},
        {"role": "assistant", "content": "What was that like?"},
    ]
    assert plan_insight("yeah it just keeps hurting", history=loop).move == "new_angle"


def test_a_heavier_conversation_gets_presence_not_technique() -> None:
    assert plan_insight("I always ruin everything and I can't do this", direction="heavier").move == "stay"


def test_the_last_move_is_not_repeated_back_to_back() -> None:
    first = plan_insight("I always mess everything up at work")
    again = plan_insight("I always mess everything up at work", last_move=first.move)
    assert again.move != first.move or again.scores[first.move] < first.scores[first.move]


def test_what_helped_this_person_shifts_the_choice() -> None:
    message = "my sister never listens when I talk about my plans"
    assert plan_insight(message).move == "test_absolute"
    learned = {"moves": {"test_absolute": {"alpha": 1.0, "beta": 6.0}, "values": {"alpha": 6.0, "beta": 1.0}}}
    assert learned_move_bias(learned)["values"] > 0 > learned_move_bias(learned)["test_absolute"]
    assert plan_insight(message, learned=learned).move == "values"


def test_thumbs_and_implicit_reactions_credit_the_move() -> None:
    store = InMemoryStore()
    service = AdaptiveProfileService(store)
    service.commit_turn("usr_insight", "I feel stuck", "Active Listen", "sharpen")
    assert service.load("usr_insight")["last_turn"]["move"] == "sharpen"
    service.rate("usr_insight", "up", "Active Listen", "sharpen")
    assert service.load("usr_insight")["moves"]["sharpen"]["alpha"] > 1.0
    # Unknown moves are ignored rather than stored.
    assert service.rate("usr_insight", "up", "", "not_a_move")["move"] is None

    profile = empty_profile("usr_implicit")
    profile["last_turn"] = {"strategy": "Active Listen", "move": "name_tension"}
    after = learn_from_message(profile, "that really helps, thank you")
    stats = after.get("moves", {}).get("name_tension")
    assert stats is None or stats["alpha"] >= 1.0  # positive or neutral, never a penalty


class RecordingLLM:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def generate_stream(self, **kwargs):
        self.calls.append(kwargs)
        yield "Stuck like one decision, or more of a fog?"


def test_the_note_reaches_the_prompt_and_the_move_rides_with_the_reply() -> None:
    llm = RecordingLLM()
    store = InMemoryStore()
    orch = ChatOrchestrator(llm_gateway=llm, store=store, quota_service=QuotaService(store))

    async def run():
        return [c async for c in orch.execute_turn_stream(user_id_hash="usr_x", message="I feel stuck", consume_quota=False)]

    chunks = asyncio.run(run())
    prompt = llm.calls[0]["system_instruction"]
    assert '[Insight for this reply: What they feel is vague ("stuck")' in prompt
    # The size note stays last, the insight right before it.
    assert prompt.rstrip().endswith("]") and prompt.index("[Insight") < prompt.index("[This turn:")
    assert any(c.get("insight_move") == "sharpen" for c in chunks)


def test_feedback_route_accepts_the_move_and_rejects_junk() -> None:
    from backend.http.identity import ReplyFeedbackPayload

    assert ReplyFeedbackPayload(rating="up", strategy="Active Listen", move="sharpen").move == "sharpen"
    with pytest.raises(Exception):
        ReplyFeedbackPayload(rating="up", move="<script>")


def test_saved_messages_keep_a_valid_move_only() -> None:
    from backend.domain.sessions.contracts import ChatSessionPayload

    payload = ChatSessionPayload(
        id="s1",
        title="t",
        createdAt="2026-09-24T10:00:00Z",
        messages=[
            {"id": "m1", "role": "assistant", "content": "hi", "insight_move": "savor"},
            {"id": "m2", "role": "assistant", "content": "yo", "insight_move": "DROP TABLE"},
        ],
    )
    moves = [m.get("insight_move") for m in payload.messages]
    assert moves == ["savor", None]
