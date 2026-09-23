# tests/backend/chat/test_guest_quota.py — Guests must not share usr_anon_default

from __future__ import annotations

from fastapi.testclient import TestClient

from backend.domain.chat.orchestrator import ChatOrchestrator
from backend.domain.quota.quota import (
    ANON_RATE_COLLECTION,
    USER_QUOTA_COLLECTION,
    QuotaService,
    anonymous_quota_key,
    is_user_quota_subject,
)
from backend.infra.store.store import InMemoryStore
from backend.main import create_app


class RecordingLLM:
    async def generate_stream(self, **kwargs):
        yield "Hello there"


def _guest_app(monkeypatch, store: InMemoryStore, quota: QuotaService) -> TestClient:
    from backend.http import chat as chat_http

    orch = ChatOrchestrator(
        llm_gateway=RecordingLLM(),
        store=store,
        quota_service=quota,
    )
    monkeypatch.setattr(chat_http, "orchestrator", orch)
    return TestClient(create_app(serve_frontend=False))


def test_shared_anon_identity_is_not_a_user_quota_subject():
    assert is_user_quota_subject("usr_anon_default") is False
    assert is_user_quota_subject("usr_signed") is True
    assert anonymous_quota_key("203.0.113.10") != "usr_anon_default"
    assert anonymous_quota_key("203.0.113.10").startswith("anon_ip_")


def test_reserve_refuses_to_open_usr_anon_default_user_bucket():
    store = InMemoryStore()
    quota = QuotaService(store)
    denied = quota.reserve("usr_anon_default", 1)
    assert denied.allowed is False
    assert store.get_document(USER_QUOTA_COLLECTION, "usr_anon_default") in (None, {})
    assert quota.snapshot("usr_anon_default").credits_5h == 0


def test_two_peers_do_not_share_an_anonymous_bucket():
    store = InMemoryStore()
    quota = QuotaService(store, anon_limit_5h=2, anon_limit_week=10)
    first = quota.reserve_anonymous("203.0.113.10", 1)
    second = quota.reserve_anonymous("203.0.113.10", 1)
    blocked = quota.reserve_anonymous("203.0.113.10", 1)
    other = quota.reserve_anonymous("203.0.113.20", 1)
    assert first.allowed and second.allowed
    assert blocked.allowed is False
    assert other.allowed is True
    assert first.limit_5h == 2
    assert first.scope == "network"
    assert store.get_document(USER_QUOTA_COLLECTION, "usr_anon_default") in (None, {})
    assert store.list_documents(USER_QUOTA_COLLECTION) == []
    assert len(store.list_documents(ANON_RATE_COLLECTION)) == 2


def test_anonymous_refund_restores_network_bucket():
    store = InMemoryStore()
    quota = QuotaService(store, anon_limit_5h=1, anon_limit_week=10)
    assert quota.reserve_anonymous("203.0.113.10", 1).allowed
    assert quota.reserve_anonymous("203.0.113.10", 1).allowed is False
    quota.refund_anonymous("203.0.113.10", 1)
    assert quota.reserve_anonymous("203.0.113.10", 1).allowed
    assert store.get_document(USER_QUOTA_COLLECTION, "usr_anon_default") in (None, {})


def test_two_guest_ips_do_not_share_usr_anon_default(monkeypatch):
    store = InMemoryStore()
    quota = QuotaService(store, anon_limit_5h=1, anon_limit_week=10)
    app = _guest_app(monkeypatch, store, quota).app
    guest_a = TestClient(app, client=("203.0.113.10", 1000))
    guest_b = TestClient(app, client=("203.0.113.20", 1000))

    first = guest_a.post("/api/chat/stream", json={"message": "hello from a"})
    assert first.status_code == 200
    assert '"scope": "network"' in first.text
    assert '"limit_5h": 1' in first.text

    exhausted = guest_a.post("/api/chat/stream", json={"message": "hello again from a"})
    assert exhausted.status_code == 429
    body = exhausted.json()
    assert body["code"] == "quota_exceeded"
    assert body["details"]["limit_5h"] == 1
    assert body["details"]["scope"] == "network"

    other = guest_b.post("/api/chat/stream", json={"message": "hello from b"})
    assert other.status_code == 200
    assert store.get_document(USER_QUOTA_COLLECTION, "usr_anon_default") in (None, {})
    assert store.list_documents(USER_QUOTA_COLLECTION) == []


def test_spoofed_forwarded_for_does_not_split_guest_quota(monkeypatch):
    store = InMemoryStore()
    quota = QuotaService(store, anon_limit_5h=1, anon_limit_week=10)
    guest = TestClient(_guest_app(monkeypatch, store, quota).app, client=("203.0.113.10", 1000))

    first = guest.post(
        "/api/chat/stream",
        json={"message": "hello", "user_id_hash": "gst_device_1"},
        headers={"X-Forwarded-For": "198.51.100.9", "X-MindPal-User-Id": "gst_device_1"},
    )
    assert first.status_code == 200
    second = guest.post(
        "/api/chat/stream",
        json={"message": "hello again", "user_id_hash": "gst_device_2"},
        headers={"X-Forwarded-For": "198.51.100.10", "X-MindPal-User-Id": "gst_device_2"},
    )
    assert second.status_code == 429
    assert store.get_document(USER_QUOTA_COLLECTION, "usr_anon_default") in (None, {})


def test_signed_in_quota_is_unchanged_and_ignores_peer(monkeypatch):
    store = InMemoryStore()
    quota = QuotaService(store, limit_5h=50, limit_week=500, anon_limit_5h=1, anon_limit_week=10)
    app = _guest_app(monkeypatch, store, quota).app
    signed = TestClient(app, client=("203.0.113.10", 1000))
    headers = {"Authorization": "Bearer dev_quota_signed"}

    for i in range(3):
        res = signed.post("/api/chat/stream", json={"message": f"hello {i}"}, headers=headers)
        assert res.status_code == 200
        assert '"scope": "account"' in res.text
        assert '"limit_5h": 50' in res.text

    assert quota.snapshot("usr_quota_signed").credits_5h == 3
    assert quota.snapshot("usr_quota_signed").limit_5h == 50
    assert store.get_document(USER_QUOTA_COLLECTION, "usr_anon_default") in (None, {})
    assert store.list_documents(ANON_RATE_COLLECTION) == []

    other_ip = TestClient(app, client=("198.51.100.20", 1000))
    follow = other_ip.post("/api/chat/stream", json={"message": "still me"}, headers=headers)
    assert follow.status_code == 200
    assert quota.snapshot("usr_quota_signed").credits_5h == 4


def test_guest_crisis_does_not_consume_network_quota(monkeypatch):
    store = InMemoryStore()
    quota = QuotaService(store, anon_limit_5h=1, anon_limit_week=10)
    guest = TestClient(_guest_app(monkeypatch, store, quota).app, client=("203.0.113.10", 1000))
    crisis = guest.post("/api/chat/stream", json={"message": "I want to kill myself"})
    assert crisis.status_code == 200
    assert "Lifeline" in crisis.text
    follow = guest.post("/api/chat/stream", json={"message": "I am feeling calmer now"})
    assert follow.status_code == 200
    blocked = guest.post("/api/chat/stream", json={"message": "one more"})
    assert blocked.status_code == 429
