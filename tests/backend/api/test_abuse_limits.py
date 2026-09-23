# tests/backend/api/test_abuse_limits.py - shared limits on writes and paid calls
"""Audit MP-17 and MP-24: unbounded saved chats and diagnostic uploads, paid
face-reaction calls with no live call, oversized bodies parsed before being
refused, and a consolidation batch with no time limit or retry backoff."""

from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient

from backend.core.errors import AppError
from backend.domain.dynamic.policy import LoadState
from backend.domain.memory.consolidation import JOBS_COLLECTION, MemoryConsolidationService
from backend.domain.sessions import contracts
from backend.infra.store.providers.memory import InMemoryStore
from backend.main import MAX_REQUEST_BYTES, create_app
from tests.backend.voice.test_voice_session import _service as voice_service

USER = "usr_limits"


def test_saved_chats_are_capped_but_existing_ones_still_update(monkeypatch) -> None:
    monkeypatch.setattr(contracts, "MAX_SESSIONS_PER_ACCOUNT", 3)
    store = InMemoryStore()
    for i in range(3):
        store.set_document("chat_sessions", f"{USER}:s{i}", {"id": f"s{i}"})
    contracts.enforce_session_cap(store, USER, "s1")  # updating an existing chat is fine
    with pytest.raises(AppError) as exc:
        contracts.enforce_session_cap(store, USER, "s_new")
    assert exc.value.code == "quota_exceeded"


def test_face_reactions_need_a_live_call() -> None:
    store = InMemoryStore()
    service = voice_service(store)
    with pytest.raises(AppError) as exc:
        service.require_live_call("usr_signed")
    assert exc.value.code == "forbidden"
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    service.require_live_call("usr_signed")
    service._live_calls.clear()
    service.teardown(user_id_hash="usr_signed", session_id=grant["session_id"], reason="client_hangup")
    with pytest.raises(AppError):
        service.require_live_call("usr_signed")


def test_support_traces_are_capped_per_call(monkeypatch) -> None:
    from backend.tools import voice_diagnostics

    store = InMemoryStore()
    monkeypatch.setattr(voice_diagnostics, "get_store", lambda: store)
    for i in range(voice_diagnostics.MAX_TRACES_PER_SESSION + 3):
        time.sleep(0.002)  # distinct millisecond ids
        voice_diagnostics.persist_voice_diagnostics("vs_1", {"events": [{"t": i}] * 5000}, user_id_hash=USER)
    stored = list(store.iter_documents(voice_diagnostics.DIAGNOSTICS_COLLECTION, prefix="vs_1:"))
    assert len(stored) == voice_diagnostics.MAX_TRACES_PER_SESSION
    assert all(len(doc["events"]) <= voice_diagnostics.MAX_TRACE_EVENTS for _id, doc in stored)


def test_oversized_bodies_are_refused_before_parsing() -> None:
    client = TestClient(create_app(serve_frontend=False))
    response = client.post(
        "/api/chat/stream",
        content=b"{}",
        headers={"Content-Type": "application/json", "Content-Length": str(MAX_REQUEST_BYTES + 1)},
    )
    assert response.status_code == 413


def test_a_failing_consolidation_job_backs_off_instead_of_blocking_the_queue() -> None:
    store = InMemoryStore()

    def failing(**_kwargs):
        raise RuntimeError("provider down")

    calm = lambda: LoadState(level="calm", pressure=0.0, drivers={}, pulse=None, overridden=True)  # noqa: E731
    service = MemoryConsolidationService(store, generate_json=failing, load=calm)
    for i in range(6):
        service.record_turn(USER, f"exam stress again {i}", "What helps?")
    service.run_due()
    job = store.get_document(JOBS_COLLECTION, USER)
    assert job["attempts"] == 1 and job["not_before"] > time.time()
    assert service.run_due()["processed"] == 0, "skipped while backing off"
