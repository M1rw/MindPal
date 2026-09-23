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
    empty = res.json()
    assert "atoms" in empty
    assert empty["atoms"] == []
    assert empty.get("summary") in ("", None)
    assert "therapeutic reflective" not in str(empty.get("summary") or "").lower()

    # Put graph
    put_res = app_client.put(
        "/api/memory/graph",
        json={"summary": "New reflective summary", "atoms": [{"id": "atom_1", "category": "goal", "value": "Meditation"}]},
        headers=auth,
    )
    assert put_res.status_code == 200
    assert len(put_res.json()["atoms"]) == 1

    patch_res = app_client.patch(
        "/api/memory/graph/items/atom_1",
        json={"value": "Evening walks"},
        headers=auth,
    )
    assert patch_res.status_code == 200
    patched = patch_res.json()["atoms"]
    assert len(patched) == 1
    assert patched[0]["value"] == "Evening walks"

    empty_patch = app_client.patch(
        "/api/memory/graph/items/atom_1",
        json={"value": "   "},
        headers=auth,
    )
    assert empty_patch.status_code == 422

    missing_patch = app_client.patch(
        "/api/memory/graph/items/missing",
        json={"value": "Nope"},
        headers=auth,
    )
    assert missing_patch.status_code == 404


def test_voice_session_token_guest_fail_closed(app_client):
    res = app_client.post("/api/voice/session-token", json={"consent_attested": True})
    assert res.status_code == 401
    assert res.json()["code"] == "unauthenticated"


def test_voice_session_token_env_off_forbidden(app_client, monkeypatch):
    monkeypatch.setenv("MINDPAL_VOICE_LIVE", "0")
    from backend.domain.flags.engine import FeatureLifecycleEngine
    from backend.http import voice as voice_http

    monkeypatch.setattr(voice_http.session_service, "flags", FeatureLifecycleEngine())
    res = app_client.post(
        "/api/voice/session-token",
        headers={"Authorization": "Bearer dev_voiceuser"},
        json={"consent_attested": True},
    )
    assert res.status_code == 403
    body = res.json()
    assert body["code"] == "forbidden"
    assert "dictation" in body["message"].lower()


def test_voice_session_token_mints_gemini_grant(app_client, monkeypatch):
    from backend.domain.flags.engine import FeatureLifecycleEngine
    from backend.domain.flags.models import FeatureDefinition, FeatureStage
    from backend.http import voice as voice_http

    class _Mint:
        def mint_ephemeral_token(self, **kwargs):
            return {
                "token": "authTokens/http-grant",
                "expires_at": "2026-09-15T00:05:00Z",
                "ws_url": "wss://example.invalid/BidiGenerateContentConstrained?access_token=x",
                "model": "models/gemini-2.5-flash-native-audio-preview-12-2025",
                "voice_id": "Kore",
                "setup": {"setup": {"model": "models/x"}},
                "setup_timeout_ms": 12000,
            }

    engine = FeatureLifecycleEngine(
        registry=[FeatureDefinition(key="voice.realtime", stage=FeatureStage.CANARY, rollout_percentage=100)]
    )
    monkeypatch.setattr(voice_http.session_service, "flags", engine)
    monkeypatch.setattr(voice_http.session_service, "token_service", _Mint())

    res = app_client.post(
        "/api/voice/session-token",
        headers={"Authorization": "Bearer dev_voiceuser"},
        json={"consent_attested": True},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["token"] == "authTokens/http-grant"
    assert not data["token"].startswith("vt_")
    assert "BidiGenerateContentConstrained" in data["ws_url"]
    assert data["session_id"].startswith("vs_")
    ended = app_client.post(
        "/api/voice/session-events",
        headers={"Authorization": "Bearer dev_voiceuser"},
        json={"session_id": data["session_id"], "event": "voice.session.teardown", "reason": "test_done", "used_s": 0},
    )
    assert ended.status_code == 200


def test_voice_reaction_env_off_forbidden(app_client, monkeypatch):
    monkeypatch.setenv("MINDPAL_VOICE_LIVE", "0")
    from backend.domain.flags.engine import FeatureLifecycleEngine
    from backend.http import voice as voice_http

    monkeypatch.setattr(voice_http.session_service, "flags", FeatureLifecycleEngine())
    res = app_client.post(
        "/api/voice/reaction",
        headers={"Authorization": "Bearer dev_voiceuser"},
        json={"text": "I finally passed"},
    )
    assert res.status_code == 403
    assert res.json()["code"] == "forbidden"


def test_voice_reaction_guest_unauthenticated(app_client):
    res = app_client.post("/api/voice/reaction", json={"text": "hello"})
    assert res.status_code == 401


def test_voice_summarize_requires_auth(app_client):
    res = app_client.post("/api/voice/summarize", json={"session_id": "vs_missing"})
    assert res.status_code == 401
    assert res.json()["code"] == "unauthenticated"


def test_voice_summarize_rejects_cross_user_and_writes_for_owner(app_client, monkeypatch):
    from backend.domain.flags.engine import FeatureLifecycleEngine
    from backend.domain.flags.models import FeatureDefinition, FeatureStage
    from backend.http import voice as voice_http

    class _Mint:
        def mint_ephemeral_token(self, **kwargs):
            return {
                "token": "authTokens/http-grant",
                "expires_at": "2026-09-15T00:05:00Z",
                "ws_url": "wss://example.invalid/BidiGenerateContentConstrained?access_token=x",
                "model": "models/gemini-2.5-flash-native-audio-preview-12-2025",
                "voice_id": "Kore",
                "setup": {"setup": {"model": "models/x"}},
                "setup_timeout_ms": 12000,
            }

    engine = FeatureLifecycleEngine(
        registry=[FeatureDefinition(key="voice.realtime", stage=FeatureStage.CANARY, rollout_percentage=100)]
    )
    monkeypatch.setattr(voice_http.session_service, "flags", engine)
    monkeypatch.setattr(voice_http.session_service, "token_service", _Mint())

    async def fake_generate(prompt: str) -> str:
        del prompt
        return "You talked about feeling stretched at work."

    monkeypatch.setattr(voice_http.summarize_service, "generate", fake_generate)

    owner = {"Authorization": "Bearer dev_voicesummarize"}
    mint = app_client.post("/api/voice/session-token", headers=owner, json={"consent_attested": True})
    assert mint.status_code == 200
    session_id = mint.json()["session_id"]

    other = app_client.post(
        "/api/voice/summarize",
        headers={"Authorization": "Bearer dev_otheruser"},
        json={"session_id": session_id, "user_transcript": "work has been a lot this week"},
    )
    assert other.status_code == 404

    empty = app_client.post(
        "/api/voice/summarize",
        headers=owner,
        json={"session_id": session_id},
    )
    assert empty.status_code == 200
    assert empty.json()["skipped"] is True
    assert empty.json()["reason"] == "no_speech"

    written = app_client.post(
        "/api/voice/summarize",
        headers=owner,
        json={
            "session_id": session_id,
            "chat_session_id": "chat_voice_http",
            "user_transcript": "work has been a lot this week and I cannot sleep",
            "ai_transcript": "that sounds exhausting. what would a quieter night look like?",
        },
    )
    assert written.status_code == 200
    body = written.json()
    assert body["skipped"] is False
    assert body["message"]["kind"] == "voice_receipt"
    assert "stretched" in body["message"]["content"] or "work" in body["message"]["content"].lower()


def test_flags_snapshot(app_client):
    res = app_client.get("/api/features")
    assert res.status_code == 200
    assert "flags" in res.json()


def test_wellness_timeline_requires_sign_in(app_client):
    res = app_client.get("/api/user/wellness-timeline")
    assert res.status_code == 401
    assert res.json()["code"] == "unauthenticated"


def test_wellness_timeline_malformed_bearer_is_unauthenticated_not_500(app_client):
    res = app_client.get(
        "/api/user/wellness-timeline",
        headers={"Authorization": "NotBearer tok"},
    )
    assert res.status_code == 401
    assert res.json()["code"] == "unauthenticated"


def test_wellness_timeline_signed_in_is_empty_without_fake_scores(app_client):
    res = app_client.get("/api/user/wellness-timeline", headers={"Authorization": "Bearer dev_wellness_empty"})
    assert res.status_code == 200
    body = res.json()
    blob = str(body).lower()
    assert body["empty"] is True
    assert body["mood_timeline"] == []
    assert body["themes"] == []
    assert body["events"] == []
    assert "phq" not in blob
    assert "gad-7" not in blob
    assert "clinical" not in blob


def test_identity_export_requires_sign_in(app_client):
    res = app_client.get("/api/user/export")
    assert res.status_code == 401
    assert res.json()["code"] == "unauthenticated"


def test_identity_delete_requires_sign_in(app_client):
    res = app_client.delete("/api/user/data")
    assert res.status_code == 401
    assert res.json()["code"] == "unauthenticated"


def test_identity_export_and_delete_account_data(app_client):
    auth = {"Authorization": "Bearer dev_exportdelete"}
    put_res = app_client.put(
        "/api/memory/graph",
        json={
            "summary": "Prefers morning walks",
            "atoms": [{"id": "habit:walk", "category": "habits", "value": "Morning walks"}],
        },
        headers=auth,
    )
    assert put_res.status_code == 200

    app_client.patch("/api/user/profile", json={"display_name": "Export User"}, headers=auth)
    app_client.post(
        "/api/chats",
        json={
            "id": "chat_export_1",
            "title": "Walks",
            "createdAt": "2026-09-15T00:00:00Z",
            "updatedAt": "2026-09-15T00:00:00Z",
            "messages": [{"role": "user", "content": "I walk in the morning"}],
        },
        headers=auth,
    )

    export_res = app_client.get("/api/user/export", headers=auth)
    assert export_res.status_code == 200
    assert "attachment; filename=" in export_res.headers.get("content-disposition", "")
    payload = export_res.json()
    assert payload["included"] == ["profile", "memory", "cloud_chat_sessions", "voice", "adaptive_profile", "memory_digests"]
    assert "Chat history stored only in this browser" in payload["not_included"]
    assert payload["profile"]["display_name"] == "Export User"
    assert payload["memory"]["summary"] == "Prefers morning walks"
    assert payload["memory"]["atoms"][0]["value"] == "Morning walks"
    assert any(session.get("id") == "chat_export_1" for session in payload["cloud_chat_sessions"])

    delete_res = app_client.delete("/api/user/data", headers=auth)
    assert delete_res.status_code == 200
    body = delete_res.json()
    assert body["status"] == "success"
    assert "profile" in body["deleted"]
    assert "memory" in body["deleted"]

    graph_res = app_client.get("/api/memory/graph", headers=auth)
    assert graph_res.status_code == 200
    assert graph_res.json()["atoms"] == []
    assert graph_res.json().get("summary") in ("", None)

    empty_export = app_client.get("/api/user/export", headers=auth)
    assert empty_export.status_code == 200
    empty_payload = empty_export.json()
    assert empty_payload["memory"]["atoms"] == []
    assert empty_payload["cloud_chat_sessions"] == []


def test_security_headers(app_client):
    res = app_client.get("/api/health")
    assert res.status_code == 200
    assert res.headers["x-content-type-options"] == "nosniff"
    assert res.headers["x-frame-options"] == "DENY"
    assert res.headers["x-xss-protection"] == "1; mode=block"
    assert res.headers["referrer-policy"] == "strict-origin-when-cross-origin"


@pytest.mark.asyncio
async def test_chat_orchestrator_crisis():
    orchestrator = ChatOrchestrator()
    turn = await orchestrator.execute_turn(user_id_hash="usr_test", message="I feel like ending my life")
    assert turn.is_crisis is True
    assert turn.risk_level == "imminent"
    assert "Lifeline" in turn.response_text


def test_voice_recall_guest_unauthenticated(app_client):
    res = app_client.post("/api/voice/recall", json={"session_id": "vs_x", "tool": "search_memory", "query": "exam"})
    assert res.status_code == 401


def test_voice_recall_rejects_unknown_tool(app_client):
    res = app_client.post(
        "/api/voice/recall",
        headers={"Authorization": "Bearer dev_voiceuser"},
        json={"session_id": "vs_x", "tool": "search_web", "query": "news"},
    )
    assert res.status_code in {400, 422}


def test_voice_recall_refuses_a_call_that_is_not_yours(app_client):
    res = app_client.post(
        "/api/voice/recall",
        headers={"Authorization": "Bearer dev_voiceuser"},
        json={"session_id": "vs_not_mine", "tool": "search_memory", "query": "exam"},
    )
    assert res.status_code in {403, 404}
