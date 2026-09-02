# tests/integration/test_api_routes.py

from __future__ import annotations

import json
import pytest


def test_health_and_readiness_endpoints(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"

    live_res = client.get("/api/health/live")
    assert live_res.status_code == 200
    assert live_res.json()["status"] == "ok"

    ready_res = client.get("/api/health/ready")
    assert ready_res.status_code == 200
    assert "status" in ready_res.json()


def test_runtime_config_endpoint(client):
    response = client.get("/runtime-config.js")
    assert response.status_code == 200
    assert "window.MINDPAL_CONFIG" in response.text


def test_chat_sync_and_debug_routes(auth_client):
    payload = {
        "message": "Hello MindPal, how are you today?",
        "history": [],
        "metadata": {"locale": "en", "model": "standard"},
    }
    res = auth_client.post("/api/chat", json=payload)
    assert res.status_code == 200, res.text
    data = res.json()
    assert "reply" in data
    assert "request_id" in data
    assert data["reply"] != ""

    request_id = data["request_id"]
    debug_res = auth_client.get(f"/api/chat/debug/{request_id}")
    assert debug_res.status_code in {200, 404}


def test_chat_sse_stream_route(auth_client):
    payload = {
        "message": "Give me a quick wellness tip.",
        "history": [],
        "metadata": {"locale": "en"},
    }
    res = auth_client.post("/api/chat/stream", json=payload)
    assert res.status_code == 200
    assert "text/event-stream" in res.headers["content-type"]
    lines = res.text.split("\n")
    data_lines = [line for line in lines if line.startswith("data: ")]
    assert len(data_lines) > 0


def test_firebase_project_id_auto_extraction():
    import json
    from backend.core.config import get_settings
    from backend.services.domain.storage.providers.firebase_provider import _firebase_project_id

    settings = get_settings().model_copy(
        update={
            "FIREBASE_PROJECT_ID": "",
            "GOOGLE_CLOUD_PROJECT": "",
            "FIREBASE_CREDENTIALS_JSON": json.dumps({"project_id": "mindpal-official-0", "private_key": "dummy"}),
        }
    )
    assert _firebase_project_id(settings) == "mindpal-official-0"


def test_unavailable_db_provider_returns_503(app, auth_client):
    from backend.services.domain.storage import UnavailableDBProvider
    storage_service = app.state.service_container.db
    original_provider = storage_service.provider
    try:
        storage_service.provider = UnavailableDBProvider(reason="Testing unavailable provider")
        res = auth_client.get("/api/user/profile")
        assert res.status_code == 503
        data = res.json()
        assert data.get("code") == "db_provider_unavailable"

        patch_res = auth_client.patch(
            "/api/user/profile",
            json={"preferences": {"communication_style": "concise"}},
        )
        assert patch_res.status_code == 503
        assert patch_res.json().get("code") == "db_provider_unavailable"
    finally:
        storage_service.provider = original_provider


def test_user_me_and_profile_routes(auth_client):
    me_res = auth_client.get("/api/user/me")
    assert me_res.status_code == 200
    me_data = me_res.json()
    assert "user_id_hash" in me_data

    prof_res = auth_client.get("/api/user/profile")
    assert prof_res.status_code == 200
    prof_data = prof_res.json()
    assert "profile" in prof_data

    patch_res = auth_client.patch(
        "/api/user/profile",
        json={"preferences": {"communication_style": "concise"}},
    )
    assert patch_res.status_code == 200


def test_memory_v3_routes(auth_client):
    load_res = auth_client.get("/api/memory/v3")
    assert load_res.status_code == 200
    assert "graph" in load_res.json()

    merge_res = auth_client.post(
        "/api/memory/v3/merge",
        json={
            "atoms": [
                {
                    "id": "atom_test_1",
                    "key": "preferences:morning_tea",
                    "value": "User likes morning tea",
                    "normalized_value": "user likes morning tea",
                    "display_value": "User likes morning tea",
                    "category": "preferences",
                    "confidence": 0.8,
                }
            ]
        },
    )
    assert merge_res.status_code == 200

    summarize_res = auth_client.post(
        "/api/memory/summarize",
        json={
            "interactions": [{"role": "user", "content": "I drink green tea every morning"}],
            "force": True,
            "save": False,
        },
    )
    assert summarize_res.status_code == 200


def test_brain_routes(auth_client):
    overview_res = auth_client.get("/api/brain/overview")
    assert overview_res.status_code == 200

    map_res = auth_client.get("/api/brain/map")
    assert map_res.status_code == 200

    search_res = auth_client.get("/api/brain/search?q=tea")
    assert search_res.status_code == 200

    plan_res = auth_client.post(
        "/api/brain/context-plan",
        json={"query": "What tea do I like?"},
    )
    assert plan_res.status_code == 200


def test_chat_store_routes(auth_client):
    get_res = auth_client.get("/api/chats/current")
    assert get_res.status_code == 200

    append_res = auth_client.post(
        "/api/chats/current/messages",
        json={
            "messages": [
                {"role": "user", "text": "Hello world!"},
                {"role": "assistant", "text": "Hello user!"},
            ]
        },
    )
    assert append_res.status_code == 200


def test_safety_routes(auth_client, client):
    classify_res = auth_client.post(
        "/api/safety/classify",
        json={"text": "I am feeling a bit stressed today"},
    )
    assert classify_res.status_code == 200
    assert "level" in classify_res.json()

    crisis_res = client.post(
        "/api/safety/render-crisis-response",
        json={"template_id": "imminent_self_harm", "locale": "en"},
    )
    assert crisis_res.status_code == 200
    assert "body" in crisis_res.json()


def test_tts_routes(auth_client, client):
    policy_res = client.post(
        "/api/tts/policy",
        json={"text": "Hello MindPal", "locale": "en"},
    )
    assert policy_res.status_code == 200

    synth_res = auth_client.post(
        "/api/tts/synthesize",
        json={"text": "Hello MindPal", "locale": "en"},
    )
    assert synth_res.status_code == 200


def test_tools_routes(auth_client):
    list_res = auth_client.get("/api/tools/list")
    assert list_res.status_code == 200
    assert "tools" in list_res.json()

    exec_res = auth_client.post(
        "/api/tools/execute",
        json={"tool": "current_time", "args": {}},
    )
    assert exec_res.status_code == 200
    assert "result" in exec_res.json() or "error" in exec_res.json()


def test_voice_v4_token_route(auth_client):
    token_res = auth_client.post("/api/voice/v4/token")
    assert token_res.status_code in {200, 502, 403}


def test_feature_flags_routes(client):
    features_res = client.get("/api/features")
    assert features_res.status_code == 200
    assert "features" in features_res.json()


def test_changelog_routes(client):
    res = client.get("/api/features/changelog")
    assert res.status_code == 200
    data = res.json()
    assert "current_version" in data
    assert "entries" in data

    dismiss_res = client.post("/api/features/changelog/dismiss", json={"version": "4.0.0"})
    assert dismiss_res.status_code == 200
    assert dismiss_res.json()["dismissed"] is True
