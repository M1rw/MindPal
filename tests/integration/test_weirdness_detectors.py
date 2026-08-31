# tests/integration/test_weirdness_detectors.py

from __future__ import annotations

import asyncio
import pytest


@pytest.mark.asyncio
async def test_concurrent_request_burst_no_deadlock(async_client):
    headers = {
        "Authorization": "Bearer mock_test_token",
        "X-MindPal-User-ID": "concurrent_user_1",
        "X-MindPal-Locale": "en",
        "X-MindPal-Channel": "web",
    }
    payload = {
        "message": "Hello from concurrent request",
        "history": [],
        "metadata": {"locale": "en"},
    }

    async def send_chat():
        return await async_client.post("/api/chat", json=payload, headers=headers)

    responses = await asyncio.gather(*[send_chat() for _ in range(5)], return_exceptions=True)

    for res in responses:
        assert not isinstance(res, Exception), f"Concurrent request raised exception: {res}"
        assert res.status_code in {200, 429}


@pytest.mark.asyncio
async def test_memory_isolation_between_users(async_client):
    headers_user_a = {
        "Authorization": "Bearer mock_test_token_a",
        "X-MindPal-User-ID": "user_alpha",
        "X-MindPal-Locale": "en",
    }
    headers_user_b = {
        "Authorization": "Bearer mock_test_token_b",
        "X-MindPal-User-ID": "user_beta",
        "X-MindPal-Locale": "en",
    }

    # Save a memory item for User A
    res_a = await async_client.post(
        "/api/memory/v3/merge",
        json={
            "atoms": [
                {
                    "id": "atom_a",
                    "key": "facts:alpha_secret",
                    "value": "Secret of Alpha",
                    "normalized_value": "secret of alpha",
                    "display_value": "Secret of Alpha",
                    "category": "facts",
                }
            ]
        },
        headers=headers_user_a,
    )
    assert res_a.status_code == 200

    # User B loads memory - should NOT see User A's secret
    res_b = await async_client.get("/api/memory/v3", headers=headers_user_b)
    assert res_b.status_code == 200
    atoms_b = res_b.json()["graph"]["atoms"]
    atom_ids_b = [atom["id"] for atom in atoms_b]
    assert "atom_a" not in atom_ids_b


@pytest.mark.asyncio
async def test_container_service_state_retention_after_error(async_client):
    headers = {
        "Authorization": "Bearer mock_test_token",
        "X-MindPal-User-ID": "error_recovery_user",
    }

    # Trigger validation error
    err_res = await async_client.post("/api/chat", json={"message": ""}, headers=headers)
    assert err_res.status_code == 422

    # Container must remain healthy for subsequent valid request
    ok_res = await async_client.post(
        "/api/chat",
        json={"message": "I am fine now", "history": []},
        headers=headers,
    )
    assert ok_res.status_code == 200
    assert ok_res.json()["reply"] != ""
