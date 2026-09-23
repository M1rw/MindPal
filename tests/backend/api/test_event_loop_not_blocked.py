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
