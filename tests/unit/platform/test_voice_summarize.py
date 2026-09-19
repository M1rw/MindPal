# tests/unit/platform/test_voice_summarize.py — live-call recap into chat history

from __future__ import annotations

import pytest

from backend.core.errors import AppError
from backend.domain.voice.session import VOICE_SESSION_COLLECTION, VoiceSessionService
from backend.domain.voice.summarize import CHAT_COLLECTION, VoiceSummarizeService
from backend.infra.store.store import InMemoryStore
from tests.unit.platform.test_voice_session import _FakeCrisis, _FakeToken, _enabled_engine


def _session(store: InMemoryStore) -> VoiceSessionService:
    return VoiceSessionService(
        token_service=_FakeToken(),
        store=store,
        flags=_enabled_engine(),
        crisis_classifier=_FakeCrisis(),
    )


def _service(store: InMemoryStore) -> tuple[VoiceSessionService, VoiceSummarizeService]:
    sessions = _session(store)

    async def fake_generate(prompt: str) -> str:
        del prompt
        return "You talked about a long week at work and wanting a quieter evening."

    summarizer = VoiceSummarizeService(session_service=sessions, store=store)
    summarizer.generate = fake_generate  # type: ignore[method-assign]
    return sessions, summarizer


@pytest.mark.asyncio
async def test_summarize_writes_a_chat_receipt() -> None:
    store = InMemoryStore()
    sessions, summarizer = _service(store)
    grant = sessions.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    sessions.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.sync",
            "input_text": "it has been a long week at work",
            "output_text": "that sounds heavy. what would rest look like tonight?",
        },
    )
    result = await summarizer.summarize(
        user_id_hash="usr_signed",
        session_id=grant["session_id"],
        chat_session_id="chat_live_1",
        user_transcript="it has been a long week at work",
        ai_transcript="that sounds heavy. what would rest look like tonight?",
    )
    assert result["skipped"] is False
    message = result["message"]
    assert message["kind"] == "voice_receipt"
    assert message["role"] == "assistant"
    assert "long week" in message["content"]
    assert "clinical" in message["content"].lower()
    assert "Call length:" not in message["content"]
    assert isinstance(message.get("voice_used_s"), int)
    saved = store.get_document(CHAT_COLLECTION, "usr_signed:chat_live_1")
    assert saved is not None
    assert saved["messages"][0]["id"] == message["id"]


@pytest.mark.asyncio
async def test_summarize_skips_empty_transcripts() -> None:
    store = InMemoryStore()
    sessions, summarizer = _service(store)
    grant = sessions.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    result = await summarizer.summarize(
        user_id_hash="usr_signed",
        session_id=grant["session_id"],
        chat_session_id="chat_empty",
    )
    assert result["skipped"] is True
    assert result["reason"] == "no_speech"
    assert store.get_document(CHAT_COLLECTION, "usr_signed:chat_empty") is None


@pytest.mark.asyncio
async def test_summarize_skips_crisis_calls() -> None:
    store = InMemoryStore()
    sessions, summarizer = _service(store)
    grant = sessions.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    sessions.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.sync",
            "input_text": "I want to kill myself tonight after this call",
            "output_text": "",
        },
    )
    result = await summarizer.summarize(
        user_id_hash="usr_signed",
        session_id=grant["session_id"],
        user_transcript="I want to kill myself tonight after this call",
        ai_transcript="",
    )
    assert result["skipped"] is True
    assert result["reason"] == "crisis_handoff"
    record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
    assert record["status"] == "stay_support"


@pytest.mark.asyncio
async def test_summarize_rejects_cross_user_session() -> None:
    store = InMemoryStore()
    sessions, summarizer = _service(store)
    grant = sessions.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    with pytest.raises(AppError) as exc:
        await summarizer.summarize(user_id_hash="usr_other", session_id=grant["session_id"])
    assert exc.value.code == "not_found"


@pytest.mark.asyncio
async def test_summarize_extracts_and_persists_memory_atoms() -> None:
    store = InMemoryStore()
    sessions, summarizer = _service(store)
    grant = sessions.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    user_speech = (
        "Hi MindPal, my name is Dimar. I couldn't sleep last night because work has been stressful. "
        "My friend Farha suggested I speak to someone."
    )
    sessions.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.sync",
            "input_text": user_speech,
            "output_text": "I'm glad you reached out, Dimar. Let's talk about what's going on.",
        },
    )
    result = await summarizer.summarize(
        user_id_hash="usr_signed",
        session_id=grant["session_id"],
        user_transcript=user_speech,
        ai_transcript="I'm glad you reached out, Dimar.",
    )
    assert result["skipped"] is False
    assert "memory" in result
    memory_receipt = result["memory"]
    assert memory_receipt["count"] >= 3

    # Check that durable memory graph was persisted to store
    graph = summarizer.memory_service.get_memory_graph("usr_signed")
    values = [a.value for a in graph.atoms]
    assert "Preferred name: Dimar" in values
    assert "Trouble sleeping" in values
    assert "Work has been stressful" in values
    assert any("Friend is Farha" in v for v in values)
    # Check that summary is automatically populated
    assert "Dimar" in graph.summary
    assert "Trouble sleeping" in graph.summary

