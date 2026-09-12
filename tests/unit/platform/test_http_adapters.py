# tests/unit/platform/test_http_adapters.py — Unit tests for HTTP adapters and orchestrator using create_app()

import pytest
from fastapi.testclient import TestClient

from backend.main import create_app
from backend.domain.chat.orchestrator import ChatOrchestrator


@pytest.fixture
def app_client():
    app = create_app(serve_frontend=False)
    return TestClient(app)


def test_identity_me(app_client):
    res = app_client.get("/api/user/me", headers={"Authorization": "Bearer dev_testuser"})
    assert res.status_code == 200
    data = res.json()
    assert data["user_id_hash"] == "usr_testuser"
    assert data["is_authenticated"] is True


def test_memory_graph_lifecycle(app_client):
    auth = {"Authorization": "Bearer dev_memuser"}

    # Get graph
    res = app_client.get("/api/memory/graph", headers=auth)
    assert res.status_code == 200
    assert "atoms" in res.json()

    # Put graph
    put_res = app_client.put(
        "/api/memory/graph",
        json={"summary": "New reflective summary", "atoms": [{"id": "atom_1", "category": "goal", "value": "Meditation"}]},
        headers=auth,
    )
    assert put_res.status_code == 200
    assert len(put_res.json()["atoms"]) == 1


def test_voice_session_token(app_client):
    res = app_client.post("/api/voice/session-token", headers={"Authorization": "Bearer dev_voiceuser"})
    assert res.status_code == 200
    data = res.json()
    assert data["token"].startswith("vt_")
    assert data["status"] == "active"


def test_flags_snapshot(app_client):
    res = app_client.get("/api/features")
    assert res.status_code == 200
    assert "flags" in res.json()


@pytest.mark.asyncio
async def test_chat_orchestrator_crisis():
    orchestrator = ChatOrchestrator()
    turn = await orchestrator.execute_turn(user_id_hash="usr_test", message="I feel like ending my life")
    assert turn.is_crisis is True
    assert turn.risk_level == "imminent"
    assert "Lifeline" in turn.response_text
