# tests/integration/test_edge_cases_security.py

from __future__ import annotations

import pytest


def test_empty_and_blank_messages(auth_client):
    res_empty = auth_client.post("/api/chat", json={"message": "", "history": []})
    assert res_empty.status_code == 422

    res_blank = auth_client.post("/api/chat", json={"message": "   \n\t ", "history": []})
    assert res_blank.status_code == 422


def test_oversized_payload_rejection(client):
    large_message = "A" * 100_000
    res = client.post("/api/chat", json={"message": large_message, "history": []})
    assert res.status_code in {413, 422}


def test_malformed_json_payload(client):
    res = client.post(
        "/api/chat",
        content="{\"message\": \"Hello\", bad json",
        headers={"Content-Type": "application/json"},
    )
    assert res.status_code == 422


def test_invalid_locale_normalization(auth_client):
    res = auth_client.post(
        "/api/chat",
        json={
            "message": "Hello MindPal",
            "metadata": {"locale": "invalid-locale-xxx-999"},
        },
    )
    assert res.status_code == 200
    assert res.json()["reply"] != ""


def test_unauthenticated_protected_route(client):
    res = client.get("/api/user/profile")
    assert res.status_code == 401


def test_brain_search_empty_query(auth_client):
    res = auth_client.get("/api/brain/search?q=")
    assert res.status_code in {422, 400}


def test_tool_execute_unknown_tool(auth_client):
    res = auth_client.post(
        "/api/tools/execute",
        json={"tool": "non_existent_tool_xyz", "args": {}},
    )
    assert res.status_code == 200
    data = res.json()
    assert "error" in data or "result" in data


def test_chat_store_conflict_version(auth_client):
    res = auth_client.put(
        "/api/chats/current",
        json={"title": "Test Chat", "messages": [], "expected_version": 99999},
    )
    assert res.status_code == 409


def test_web_search_url_ssrf_filtering():
    from backend.features.tools.web_search_parsers import clean_url_string
    from backend.tools.web_search_tool import _clean_url

    valid_url = "https://example.com/news/article"
    assert clean_url_string(valid_url) == valid_url
    assert _clean_url(valid_url) == valid_url

    ssrf_targets = [
        "http://127.0.0.1/admin",
        "http://169.254.169.254/latest/meta-data/",
        "http://localhost:8080/secret",
        "http://0x7f000001/internal",
        "http://[::1]/debug",
        "http://[fec0::1]/admin",
        "http://[fec0:0:0:0:1::1]/secret",
        "file:///etc/passwd",
        "gopher://127.0.0.1:70",
        "http://user:pass@example.com/secret",
        "http://user:secret@127.0.0.1/admin",
    ]

    for target in ssrf_targets:
        assert clean_url_string(target) == "", f"clean_url_string failed to reject {target}"
        assert _clean_url(target) == "", f"_clean_url failed to reject {target}"


def test_chat_debug_access_control(auth_client):
    from backend.models.schemas import ProviderCallTrace, ProviderChainTrace

    services = auth_client.app.state.service_container
    me_res = auth_client.get("/api/user/me")
    assert me_res.status_code == 200
    user_hash = me_res.json()["user_id_hash"]

    # 1. Trace owned by another user -> 403 Forbidden
    other_trace = ProviderChainTrace(
        request_id="req_other_user_123",
        provider_used="offline",
        user_id_hash="usr_other_user_hash_456",
        calls=[ProviderCallTrace(provider="offline", attempted=True, succeeded=True)],
    )
    services.llm._cache_trace(other_trace)
    res_other = auth_client.get(f"/api/chat/debug/{other_trace.request_id}")
    assert res_other.status_code == 403

    # 2. Trace with no user_id_hash (None) -> 403 Forbidden
    unassigned_trace = ProviderChainTrace(
        request_id="req_unassigned_123",
        provider_used="offline",
        user_id_hash=None,
        calls=[ProviderCallTrace(provider="offline", attempted=True, succeeded=True)],
    )
    services.llm._cache_trace(unassigned_trace)
    res_unassigned = auth_client.get(f"/api/chat/debug/{unassigned_trace.request_id}")
    assert res_unassigned.status_code == 403

    # 3. Trace owned by the requesting user -> 200 OK
    owner_trace = ProviderChainTrace(
        request_id="req_owner_user_123",
        provider_used="offline",
        user_id_hash=user_hash,
        calls=[ProviderCallTrace(provider="offline", attempted=True, succeeded=True)],
    )
    services.llm._cache_trace(owner_trace)
    res_owner = auth_client.get(f"/api/chat/debug/{owner_trace.request_id}")
    assert res_owner.status_code == 200
    assert res_owner.json()["request_id"] == owner_trace.request_id
