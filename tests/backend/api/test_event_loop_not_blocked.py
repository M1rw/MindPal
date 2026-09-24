# tests/backend/api/test_event_loop_not_blocked.py - a slow dependency stalls one request, not all
"""Audit MP-09: the async chat route called Firebase verification, the safety
check and the quota store synchronously, so while one of them waited, every
other request on the same worker waited too."""

from __future__ import annotations

import asyncio
import time

import httpx
import pytest

from backend.http import chat as chat_http
from backend.main import create_app

SLOW_S = 0.6


@pytest.mark.asyncio
async def test_a_slow_token_check_does_not_hold_up_other_requests(monkeypatch) -> None:
    real_verify = chat_http.verify_auth_header

    def slow_verify(authorization):
        time.sleep(SLOW_S)  # a stalled identity or storage call
        return real_verify(authorization)

    monkeypatch.setattr(chat_http, "verify_auth_header", slow_verify)
    app = create_app(serve_frontend=False)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        started = time.perf_counter()
        chat = asyncio.create_task(client.post("/api/chat/stream", json={"message": "hi"}))
        health_task = asyncio.create_task(client.get("/api/health"))
        health = await health_task
        waited = time.perf_counter() - started
        await chat
    assert health.status_code == 200
    assert waited < SLOW_S / 2, f"health waited {waited:.2f}s behind the chat request"


@pytest.mark.asyncio
async def test_a_slow_recap_store_call_does_not_hold_up_other_requests(monkeypatch) -> None:
    from backend.domain.voice.services.summarize import VoiceSummarizeService
    from backend.http import voice as voice_http

    def slow_lookup(self, *, user_id_hash, session_id):
        time.sleep(SLOW_S)  # a stalled store read inside the recap
        raise voice_http.AppError("not_found", "That live voice session is not available.")

    monkeypatch.setattr(VoiceSummarizeService, "owned_record", slow_lookup)
    app = create_app(serve_frontend=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        started = time.perf_counter()
        recap = asyncio.create_task(client.post(
            "/api/voice/summarize",
            headers={"Authorization": "Bearer dev_recap"},
            json={"session_id": "vs_1"},
        ))
        health = await asyncio.create_task(client.get("/api/health"))
        waited = time.perf_counter() - started
        await recap
    assert health.status_code == 200
    assert waited < SLOW_S / 2, f"health waited {waited:.2f}s behind the recap"
