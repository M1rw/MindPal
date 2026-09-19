"""Memory and past-chat lookups for the live voice model: own call only, any language."""

import pytest

from backend.core.errors import AppError
from backend.domain.memory.graph import MemoryGraphService
from backend.domain.voice.recall import (
    MAX_PER_CALL,
    MIN_INTERVAL_S,
    NOTHING_FOUND,
    VoiceRecallService,
    tokens,
)
from backend.infra.store.store import InMemoryStore

USER = "usr_recall_owner"
OTHER = "usr_recall_other"


class Clock:
    def __init__(self) -> None:
        self.t = 100.0

    def __call__(self) -> float:
        return self.t


@pytest.fixture()
def world():
    store = InMemoryStore()
    store.set_document("voice_sessions", "vs_mine", {"user_id_hash": USER, "status": "active"})
    store.set_document("voice_sessions", "vs_done", {"user_id_hash": USER, "status": "torn_down"})
    store.set_document("voice_sessions", "vs_theirs", {"user_id_hash": OTHER, "status": "active"})
    store.set_document(
        "memory_graphs",
        USER,
        {
            "summary": "Student, sleeps badly lately.",
            "atoms": [
                {"id": "a1", "category": "studies", "value": "Final exam in physics on Monday"},
                {"id": "a2", "category": "people", "value": "Sister Nour lives in Cairo"},
            ],
        },
    )
    store.set_document(
        "chat_sessions",
        f"{USER}:old",
        {
            "title": "Exam stress",
            "updatedAt": "2026-09-01T10:00:00Z",
            "messages": [{"role": "user", "content": "I am so worried about the physics exam"}],
        },
    )
    store.set_document(
        "chat_sessions",
        f"{USER}:new",
        {
            "title": "أختي",
            "updatedAt": "2026-09-15T10:00:00Z",
            "messages": [
                {"role": "user", "content": "اشتقت لأختي نور كثيرا"},
                {"role": "assistant", "content": "متى آخر مرة كلمتيها؟"},
            ],
        },
    )
    store.set_document(
        "chat_sessions",
        f"{OTHER}:x",
        {"title": "Not yours", "updatedAt": "2026-09-16", "messages": [{"role": "user", "content": "physics exam secret"}]},
    )
    clock = Clock()
    service = VoiceRecallService(store=store, memory=MemoryGraphService(store=store), clock=clock)
    return service, clock


def recall(service, tool, query, session="vs_mine", user=USER):
    return service.recall(user_id_hash=user, session_id=session, tool=tool, query=query)


def test_memory_puts_the_relevant_fact_first(world):
    service, _ = world
    result = recall(service, "search_memory", "exam")
    assert result.found
    lines = result.result.splitlines()
    assert lines[0].startswith("Summary:")
    assert "physics" in lines[1]


def test_past_chats_find_the_caller_only(world):
    service, _ = world
    result = recall(service, "search_past_chats", "physics exam")
    assert result.found
    assert "Exam stress" in result.result
    assert "secret" not in result.result, "another user's chat must never appear"


def test_past_chats_in_arabic(world):
    service, clock = world
    clock.t += MIN_INTERVAL_S
    result = recall(service, "search_past_chats", "أختي نور")
    assert result.found
    assert "نور" in result.result


def test_japanese_is_searchable_without_spaces():
    assert {"試験", "大学"} <= tokens("大学の試験")


def test_nothing_found_is_said_plainly(world):
    service, _ = world
    result = recall(service, "search_past_chats", "volcano")
    assert not result.found
    assert result.result == NOTHING_FOUND


def test_only_the_callers_own_open_call(world):
    service, _ = world
    with pytest.raises(AppError):
        recall(service, "search_memory", "exam", session="vs_theirs")
    with pytest.raises(AppError):
        recall(service, "search_memory", "exam", session="vs_done")
    with pytest.raises(AppError):
        recall(service, "search_memory", "exam", session="vs_missing")


def test_guests_get_nothing(world):
    service, _ = world
    service.store.set_document("voice_sessions", "vs_guest", {"user_id_hash": "usr_anon", "status": "active"})
    result = recall(service, "search_memory", "exam", session="vs_guest", user="usr_anon")
    assert not result.found


def test_rate_limited_per_call(world):
    service, clock = world
    assert recall(service, "search_memory", "exam").found
    assert not recall(service, "search_memory", "exam").found, "too soon"
    for _ in range(MAX_PER_CALL):
        clock.t += MIN_INTERVAL_S
        recall(service, "search_memory", "exam")
    clock.t += MIN_INTERVAL_S
    assert "Too many lookups" in recall(service, "search_memory", "exam").result


def test_unknown_tool_refused(world):
    service, _ = world
    with pytest.raises(AppError):
        recall(service, "search_web", "news")
