# tests/backend/api/test_usage_route.py - the Usage screen reads credits without spending one
from __future__ import annotations

from fastapi.testclient import TestClient

from backend.main import create_app

KEYS = {"credits_5h", "limit_5h", "reset_5h_seconds", "credits_week", "limit_week", "reset_week_seconds", "scope"}


def test_signed_out_usage_is_the_network_window_and_costs_nothing() -> None:
    client = TestClient(create_app(serve_frontend=False))
    first = client.get("/api/usage")
    assert first.status_code == 200
    chat = first.json()["chat"]
    assert set(chat) == KEYS and chat["scope"] == "network" and chat["limit_5h"] > 0
    again = client.get("/api/usage").json()["chat"]
    assert again["credits_5h"] == chat["credits_5h"]  # reading never reserves a credit
