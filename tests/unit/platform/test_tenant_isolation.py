# tests/unit/platform/test_tenant_isolation.py
#
# Every route that reads or writes durable per-user state used to accept an
# unauthenticated caller and key that state on one shared guest identity
# (`usr_anon_default`). Two strangers therefore shared one chat list, one
# profile, one insights bucket and one telemetry row — readable, overwritable
# and deletable by either of them. These tests fail against that behaviour.

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.main import create_app

# (method, path, body). Bodies are deliberately empty where one is accepted:
# the credential must be rejected before the payload is even looked at, so an
# unauthenticated caller is told to sign in rather than handed the schema.
ACCOUNT_STATE_ROUTES = [
    ("get", "/api/chats", None),
    ("post", "/api/chats", {}),
    ("get", "/api/chats/some_id", None),
    ("delete", "/api/chats/some_id", None),
    ("get", "/api/chats/current", None),
    ("put", "/api/chats/current", {}),
    ("delete", "/api/chats/current", None),
    ("post", "/api/chats/current/messages", {}),
    ("get", "/api/user/profile", None),
    ("patch", "/api/user/profile", {}),
    ("get", "/api/user/insights", None),
    ("get", "/api/user/wellness-timeline", None),
    ("get", "/api/user/export", None),
    ("delete", "/api/user/data", None),
    ("get", "/api/greeting", None),
    ("post", "/api/sessions/telemetry", {}),
    ("put", "/api/memory/graph", {}),
    ("patch", "/api/memory/graph/items/a1", {}),
    ("delete", "/api/memory/graph/items/a1", None),
    ("post", "/api/memory/summary/refresh", None),
    ("get", "/api/system/route-catalog", None),
]

_ROUTE_IDS = [f"{method}-{path}" for method, path, _ in ACCOUNT_STATE_ROUTES]


@pytest.fixture
def client():
    return TestClient(create_app(serve_frontend=False))


def _call(client, method: str, path: str, body, headers=None):
    kwargs = {"headers": headers} if headers else {}
    if body is not None:
        kwargs["json"] = body
    return getattr(client, method)(path, **kwargs)


@pytest.mark.parametrize(("method", "path", "body"), ACCOUNT_STATE_ROUTES, ids=_ROUTE_IDS)
def test_account_state_routes_refuse_guests(client, method: str, path: str, body) -> None:
    response = _call(client, method, path, body)
    assert response.status_code == 401, f"{method.upper()} {path} answered a guest"
    assert response.json()["code"] == "unauthenticated"


@pytest.mark.parametrize(("method", "path", "body"), ACCOUNT_STATE_ROUTES, ids=_ROUTE_IDS)
def test_account_state_routes_refuse_invalid_credentials(client, method: str, path: str, body) -> None:
    """A credential that does not verify is refused, not downgraded to a guest."""
    response = _call(
        client, method, path, body, headers={"Authorization": "Bearer eyJhbGciOiJSUzI1NiJ9.forged"}
    )
    assert response.status_code == 401, f"{method.upper()} {path} accepted a forged bearer"


def test_two_guests_cannot_reach_each_others_chats(client) -> None:
    saved = client.post(
        "/api/chats",
        json={
            "id": "private_chat",
            "title": "Private",
            "createdAt": "2026-09-15T00:00:00Z",
            "messages": [{"role": "user", "content": "something I told nobody"}],
        },
        headers={"Authorization": "Bearer dev_alice"},
    )
    assert saved.status_code == 200

    # A second account never sees it...
    other = client.get("/api/chats", headers={"Authorization": "Bearer dev_bob"})
    assert other.status_code == 200
    assert other.json()["sessions"] == []
    assert client.get("/api/chats/private_chat", headers={"Authorization": "Bearer dev_bob"}).status_code == 404

    # ...and a guest cannot list anything at all.
    assert client.get("/api/chats").status_code == 401

    mine = client.get("/api/chats", headers={"Authorization": "Bearer dev_alice"})
    assert [s["id"] for s in mine.json()["sessions"]] == ["private_chat"]


def test_guest_identity_has_no_storage_key(client) -> None:
    """/api/user/me answers a guest, but names no durable bucket to write to."""
    body = client.get("/api/user/me").json()
    assert body["is_authenticated"] is False
    assert body["user_id_hash"] == ""


def test_guest_memory_reads_are_empty_not_shared(client) -> None:
    client.put(
        "/api/memory/graph",
        json={"summary": "Alice detail", "atoms": [{"id": "a1", "category": "facts", "value": "Alice"}]},
        headers={"Authorization": "Bearer dev_alice_mem"},
    )
    guest_graph = client.get("/api/memory/graph")
    assert guest_graph.status_code == 200
    assert guest_graph.json()["atoms"] == []
    assert guest_graph.json()["summary"] == ""
    assert client.get("/api/memory/summary").json()["summary"] == ""


def test_features_and_health_stay_open_to_guests(client) -> None:
    """The hardening must not lock out the routes a signed-out visitor needs."""
    assert client.get("/api/health").status_code == 200
    flags = client.get("/api/features")
    assert flags.status_code == 200
    assert "presence_enabled" in flags.json()["flags"]
