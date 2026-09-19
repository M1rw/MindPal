# tests/unit/platform/test_chat_surface_hardening.py
#
# The chat surface takes attacker-controlled text and forwards it to a provider.
# Safety screened only the `message` field, and nothing had a size ceiling, so a
# disclosure could be moved one turn back into `history` and sail past the crisis
# check while still reaching the model.

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.domain.chat.orchestrator import ChatOrchestrator
from backend.http.chat import MAX_HISTORY_TURNS, MAX_MESSAGE_CHARS
from backend.main import create_app


@pytest.fixture
def client():
    return TestClient(create_app(serve_frontend=False))


@pytest.fixture
def orchestrator():
    return ChatOrchestrator()


# --- safety ------------------------------------------------------------------


def test_a_disclosure_in_the_current_message_is_caught(orchestrator) -> None:
    result = orchestrator._classify_turn("i want to die", [])
    assert result.is_crisis is True


def test_a_disclosure_moved_into_history_is_still_caught(orchestrator) -> None:
    """The evasion the message-only check allowed."""
    result = orchestrator._classify_turn(
        "anyway what should i have for lunch",
        [{"role": "user", "content": "i want to kill myself"}],
    )
    assert result.is_crisis is True
    assert result.crisis_response


def test_assistant_turns_in_history_do_not_trigger_a_crisis(orchestrator) -> None:
    """MindPal naming a crisis line is not the caller disclosing one."""
    result = orchestrator._classify_turn(
        "thanks, that helps",
        [
            {
                "role": "assistant",
                "content": "You can reach the National Suicide and Crisis Lifeline at 988.",
            }
        ],
    )
    assert result.is_crisis is False


def test_an_old_resolved_disclosure_does_not_re_trigger(orchestrator) -> None:
    """Only recent user turns count; a conversation that moved on stays moved on."""
    history = [
        {"role": "user", "content": "i wanted to die last year"},
        {"role": "assistant", "content": "thank you for telling me"},
        {"role": "user", "content": "things are better now"},
        {"role": "assistant", "content": "i'm glad"},
        {"role": "user", "content": "i started running again"},
    ]
    assert orchestrator._classify_turn("what should i cook tonight", history).is_crisis is False


def test_crisis_response_is_returned_without_spending_a_credit(client) -> None:
    response = client.post(
        "/api/chat/stream",
        json={"message": "i want to end my life", "history": []},
        headers={"Authorization": "Bearer dev_crisis_user"},
    )
    assert response.status_code == 200
    body = response.text
    assert "988" in body
    assert "Safety Shield" in body
    assert '"usage"' not in body, "a crisis turn must not reserve chat credits"


# --- payload ceilings --------------------------------------------------------


def test_an_oversized_message_is_refused(client) -> None:
    response = client.post(
        "/api/chat/stream",
        json={"message": "x" * (MAX_MESSAGE_CHARS + 1)},
        headers={"Authorization": "Bearer dev_big"},
    )
    assert response.status_code == 422


def test_an_unbounded_history_is_refused(client) -> None:
    response = client.post(
        "/api/chat/stream",
        json={
            "message": "hello",
            "history": [{"role": "user", "content": "x"}] * (MAX_HISTORY_TURNS + 1),
        },
        headers={"Authorization": "Bearer dev_big"},
    )
    assert response.status_code == 422


def test_an_unknown_model_tier_is_refused(client) -> None:
    """The tier picks the credit cost, so it is not a free-text field."""
    response = client.post(
        "/api/chat/stream",
        json={"message": "hello", "model": "free"},
        headers={"Authorization": "Bearer dev_big"},
    )
    assert response.status_code == 422


def test_nested_telemetry_blobs_are_not_stored(client) -> None:
    """Telemetry is a small flat map, not client-controlled storage."""
    response = client.post(
        "/api/chat/stream",
        json={
            "message": "hello",
            "telemetry": {f"k{i}": i for i in range(200)},
        },
        headers={"Authorization": "Bearer dev_big"},
    )
    assert response.status_code == 422


def test_chat_session_message_count_is_clipped(client) -> None:
    auth = {"Authorization": "Bearer dev_clipper"}
    saved = client.post(
        "/api/chats",
        json={
            "id": "huge",
            "title": "Huge",
            "createdAt": "2026-09-15T00:00:00Z",
            "messages": [{"role": "user", "content": f"turn {i}"} for i in range(5_000)],
        },
        headers=auth,
    )
    assert saved.status_code == 200
    assert len(saved.json()["messages"]) <= 500


def test_a_session_id_cannot_escape_its_key_namespace(client) -> None:
    """The id becomes part of the document key, so a slash is not acceptable."""
    response = client.post(
        "/api/chats",
        json={"id": "../other-user", "title": "x", "createdAt": "2026-09-15T00:00:00Z"},
        headers={"Authorization": "Bearer dev_pathy"},
    )
    assert response.status_code == 422
    assert response.json()["code"] == "payload_invalid"


def test_profile_settings_are_bounded_and_scalar(client) -> None:
    auth = {"Authorization": "Bearer dev_profile"}
    assert client.patch("/api/user/profile", json={"settings": {"theme": "dark"}}, headers=auth).status_code == 200
    assert client.patch(
        "/api/user/profile", json={"settings": {"nested": {"deep": True}}}, headers=auth
    ).status_code == 422
    assert client.patch(
        "/api/user/profile", json={"settings": {f"k{i}": i for i in range(200)}}, headers=auth
    ).status_code == 422


def test_patching_a_profile_stored_without_settings_does_not_500(client) -> None:
    """A profile written before `settings` existed used to raise KeyError."""
    from backend.http.identity import identity_service

    identity_service.store.set_document(
        "user_profiles", "usr_legacy_profile", {"user_id_hash": "usr_legacy_profile", "display_name": "Old"}
    )
    response = client.patch(
        "/api/user/profile",
        json={"settings": {"theme": "dark"}},
        headers={"Authorization": "Bearer dev_legacy_profile"},
    )
    assert response.status_code == 200
    assert response.json()["settings"]["theme"] == "dark"


# --- routing and contracts ---------------------------------------------------


def test_current_session_routes_are_not_shadowed_by_the_id_route(client) -> None:
    """`/api/chats/current` was declared after `/api/chats/{session_id}`.

    FastAPI matches in registration order, so "current" was consumed as a
    session id and the three legacy handlers were unreachable.
    """
    auth = {"Authorization": "Bearer dev_current"}
    saved = client.put(
        "/api/chats/current",
        json={"title": "Working", "messages": [{"role": "user", "content": "hi"}]},
        headers=auth,
    )
    assert saved.status_code == 200

    fetched = client.get("/api/chats/current", headers=auth)
    assert fetched.status_code == 200
    # The parameterized handler would 404 here, because no chat is saved under
    # the literal id "current".
    assert fetched.json()["messages"][0]["content"] == "hi"

    assert client.delete("/api/chats/current", headers=auth).json()["status"] == "deleted"


def test_memory_summary_refresh_accepts_the_bodyless_call_the_client_makes(client) -> None:
    """The web client posts no body; the endpoint answered 422."""
    auth = {"Authorization": "Bearer dev_refresh"}
    client.put(
        "/api/memory/graph",
        json={"atoms": [{"id": "g1", "category": "goals", "value": "Sleep before midnight"}]},
        headers=auth,
    )
    refreshed = client.post("/api/memory/summary/refresh", headers=auth)
    assert refreshed.status_code == 200
    assert "Sleep before midnight" in refreshed.json()["summary"]


def test_memory_put_clips_atoms_like_the_merge_path_does(client) -> None:
    auth = {"Authorization": "Bearer dev_clip"}
    saved = client.put(
        "/api/memory/graph",
        json={
            "atoms": [
                {"id": f"a{i}", "category": "facts", "value": "v" * 1_000} for i in range(100)
            ]
        },
        headers=auth,
    )
    assert saved.status_code == 200
    atoms = saved.json()["atoms"]
    assert len(atoms) <= 16
    assert all(len(a["value"]) <= 240 for a in atoms)


def test_voice_usage_route_is_live_not_a_placeholder(client) -> None:
    """Omitting it from IMPLEMENTED registered a 501 placeholder over the path."""
    guest = client.get("/api/voice/usage")
    assert guest.status_code == 401

    signed_in = client.get("/api/voice/usage", headers={"Authorization": "Bearer dev_usage"})
    assert signed_in.status_code == 200
    assert set(signed_in.json()) >= {"used_s", "cap_s", "remaining_s", "in_call"}


def test_security_headers_include_a_content_security_policy(client) -> None:
    headers = client.get("/api/health").headers
    assert "Content-Security-Policy" in headers
    assert "frame-ancestors 'none'" in headers["Content-Security-Policy"]
    assert "https://*.firebaseapp.com" in headers["Content-Security-Policy"]
    assert headers["cross-origin-opener-policy"] == "same-origin-allow-popups"
    assert headers["x-content-type-options"] == "nosniff"
