# tests/backend/voice/test_voice_settle_once.py - a call is settled exactly once
"""Audit MP-03/04/18/25 and the voice half of MP-06.

MP-03  warm after teardown reopened the session; a second teardown refunded again.
MP-04  two teardowns that read the same live record both refunded; a stale event
       write could overwrite a settled or frozen session.
MP-18  a store failure after token mint stranded the whole day's hold.
MP-25  a refund settled after midnight was subtracted from the new day's counter.
MP-06  a recap paused on its model call recreated a deleted session and receipt.
"""

from __future__ import annotations

import time

import pytest

from backend.core.errors import AppError
from backend.domain.voice.runtime.records import save_session_record
from backend.domain.voice.runtime.usage import utc_day
from backend.domain.voice.services.session import VOICE_SESSION_COLLECTION
from backend.domain.voice.services.summarize import CHAT_COLLECTION, VoiceSummarizeService
from backend.infra.store.providers.memory import InMemoryStore
from tests.backend.voice.test_voice_session import _service

USER = "usr_signed"
USAGE = "voice_minute_reservations"


def _used(store: InMemoryStore) -> int:
    return int((store.get_document(USAGE, USER) or {}).get("used_s") or 0)


def _minted_call(store: InMemoryStore, *, elapsed_s: int = 100):
    service = _service(store)
    grant = service.mint(user_id_hash=USER, is_authenticated=True, consent_attested=True)
    sid = grant["session_id"]
    service.handle_event(user_id_hash=USER, payload={"session_id": sid, "event": "voice.session.warm", "t_setup_ms": 900})
    record = store.get_document(VOICE_SESSION_COLLECTION, sid)
    record["created_at"] = time.time() - elapsed_s
    store.set_document(VOICE_SESSION_COLLECTION, sid, record)
    return service, sid, int(record["reserved_s"])


def _teardown(service, sid):
    return service.handle_event(
        user_id_hash=USER, payload={"session_id": sid, "event": "voice.session.teardown", "reason": "client_hangup"}
    )


def test_a_settled_call_cannot_be_reopened_or_refunded_twice() -> None:
    store = InMemoryStore()
    service, sid, reserved = _minted_call(store)
    _teardown(service, sid)
    after_first = _used(store)
    assert after_first == pytest.approx(100, abs=2)

    for _ in range(3):
        reply = service.handle_event(user_id_hash=USER, payload={"session_id": sid, "event": "voice.session.warm"})
        assert reply["already_settled"] is True
        assert store.get_document(VOICE_SESSION_COLLECTION, sid)["status"] == "torn_down"
        assert _teardown(service, sid)["already_settled"] is True
    assert _used(store) == after_first, "replayed warm/teardown refunded again"


def test_every_event_after_teardown_leaves_the_session_final() -> None:
    store = InMemoryStore()
    service, sid, _ = _minted_call(store)
    _teardown(service, sid)
    for event in ("voice.floor.transition", "voice.transcript.sync", "voice.safety.risk_rating", "voice.session.warm"):
        service.handle_event(user_id_hash=USER, payload={"session_id": sid, "event": event, "floor": "user", "risk": "none"})
        assert store.get_document(VOICE_SESSION_COLLECTION, sid)["status"] == "torn_down", event


def test_concurrent_teardowns_settle_once() -> None:
    """Both callers read a live record; only the transaction winner refunds."""
    store = InMemoryStore()
    service, sid, reserved = _minted_call(store)
    stale = store.get_document(VOICE_SESSION_COLLECTION, sid)
    before = _used(store)
    first = service.teardown(user_id_hash=USER, session_id=sid, reason="client_hangup")
    second = service.teardown(user_id_hash=USER, session_id=sid, reason="page_unload")
    assert first["refund_s"] > 0 and second["already_settled"] is True
    assert before - _used(store) == first["refund_s"]
    # A stale event write carrying the old live record cannot reopen it.
    save_session_record(store, sid, {**stale, "status": "warm"})
    assert store.get_document(VOICE_SESSION_COLLECTION, sid)["status"] == "torn_down"


def test_a_stale_write_cannot_lift_a_crisis_freeze() -> None:
    store = InMemoryStore()
    service, sid, _ = _minted_call(store)
    stale = store.get_document(VOICE_SESSION_COLLECTION, sid)
    frozen = {**stale, "status": "crisis_freeze", "floor": "crisis_freeze"}
    store.set_document(VOICE_SESSION_COLLECTION, sid, frozen)
    save_session_record(store, sid, {**stale, "floor": "user"})
    assert store.get_document(VOICE_SESSION_COLLECTION, sid)["floor"] == "crisis_freeze"


def test_a_refund_interrupted_by_a_crash_is_finished_once_by_the_next_attempt(monkeypatch) -> None:
    store = InMemoryStore()
    service, sid, _ = _minted_call(store)
    before = _used(store)
    real_refund = service.usage_lifecycle.refund
    monkeypatch.setattr(service.usage_lifecycle, "refund", lambda *a, **k: None)  # storage down
    service.teardown(user_id_hash=USER, session_id=sid, reason="client_hangup")
    assert _used(store) == before, "nothing applied while storage was down"
    assert store.get_document(VOICE_SESSION_COLLECTION, sid)["settlement"]["applied"] is False
    monkeypatch.setattr(service.usage_lifecycle, "refund", real_refund)
    service.teardown(user_id_hash=USER, session_id=sid, reason="client_hangup")
    service.teardown(user_id_hash=USER, session_id=sid, reason="client_hangup")
    settled = store.get_document(VOICE_SESSION_COLLECTION, sid)["settlement"]
    assert settled["applied"] is True
    assert before - _used(store) == settled["refund_s"]


def test_a_refund_after_midnight_does_not_touch_the_new_day() -> None:
    store = InMemoryStore()
    service, sid, _ = _minted_call(store)
    record = store.get_document(VOICE_SESSION_COLLECTION, sid)
    record["charged_day"] = "2000-01-01"
    store.set_document(VOICE_SESSION_COLLECTION, sid, record)
    # Today's counter already carries a new call's charge.
    store.set_document(USAGE, USER, {"user_id_hash": USER, "day": utc_day(), "used_s": 600})
    service.teardown(user_id_hash=USER, session_id=sid, reason="client_hangup")
    assert _used(store) == 600


class _FailingSessionStore(InMemoryStore):
    def set_document(self, collection, doc_id, data):
        if collection == VOICE_SESSION_COLLECTION:
            raise RuntimeError("storage write failed")
        return super().set_document(collection, doc_id, data)


def test_a_failed_persist_after_mint_gives_the_minutes_back() -> None:
    store = _FailingSessionStore()
    service = _service(store)
    with pytest.raises(AppError) as exc:
        service.mint(user_id_hash=USER, is_authenticated=True, consent_attested=True)
    assert exc.value.code == "unavailable"
    assert _used(store) == 0
    assert not (store.get_document("voice_active_sessions", USER) or {}).get("session_id")


@pytest.mark.asyncio
async def test_a_recap_finishing_after_account_deletion_writes_nothing() -> None:
    store = InMemoryStore()
    sessions, sid, _ = _minted_call(store)
    sessions.handle_event(
        user_id_hash=USER,
        payload={"session_id": sid, "event": "voice.transcript.sync",
                 "input_text": "it has been a long week at work and my sister Noor visited",
                 "output_text": "that sounds like a lot. how was the visit?"},
    )
    summarizer = VoiceSummarizeService(session_service=sessions, store=store)

    async def generate_then_find_account_deleted(prompt: str) -> str:
        del prompt
        store.delete_document(VOICE_SESSION_COLLECTION, sid)  # DELETE /api/user/data meanwhile
        return "You talked about a long week and a visit from your sister."

    summarizer.generate = generate_then_find_account_deleted  # type: ignore[method-assign]
    result = await summarizer.summarize(
        user_id_hash=USER, session_id=sid, chat_session_id="chat_1",
        user_transcript="it has been a long week at work and my sister Noor visited",
        ai_transcript="that sounds like a lot. how was the visit?",
    )
    assert result == {"skipped": True, "reason": "session_deleted"}
    assert store.get_document(VOICE_SESSION_COLLECTION, sid) is None
    assert store.get_document(CHAT_COLLECTION, f"{USER}:chat_1") is None
    assert store.get_document("memory_graphs", USER) is None
