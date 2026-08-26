from __future__ import annotations

import json
from types import SimpleNamespace

import httpx
import pytest

from backend.api.dependencies import (
    RequestContext,
    build_service_container,
    get_request_context,
    require_authenticated_session,
)
from backend.core.config import Settings
from backend.core.security import hash_user_id
from backend.main import create_app
from backend.models.chat import LLMResponse
from backend.models.user import UserChannel, UserSession


def _settings() -> Settings:
    return Settings(
        ENVIRONMENT="test",
        ENABLE_FIREBASE=False,
        ALLOW_ANONYMOUS_SESSIONS=True,
        REQUIRE_AUTH_FOR_PROVIDER_CALLS=False,
        REQUIRE_REMOTE_LLM_PROVIDER=False,
        ENABLE_OFFLINE_LLM_FALLBACK=True,
        ENABLE_LLM_SAFETY_CLASSIFIER=False,
        ENABLE_LLM_OUTPUT_REWRITE=False,
        ENABLE_LLM_RAG_PLANNING=False,
        ENABLE_LLM_MEMORY_SUMMARIZATION=False,
        CHAT_RATE_LIMIT_PER_MINUTE=500,
        QUOTA_LIMIT_5H=500,
        QUOTA_LIMIT_WEEK=5_000,
    )


def _app_with_authenticated_test_session():
    settings = _settings()
    app = create_app(settings)
    services = build_service_container(settings)

    async def fake_generation(_: object) -> SimpleNamespace:
        return SimpleNamespace(
            response=LLMResponse(
                text="I hear you. Let’s take one small, practical next step together.",
                provider_used="feature-contract-fake",
                fallback_count=0,
                latency_ms=1.0,
            )
        )

    session = UserSession(
        raw_user_id="feature-contract-user",
        user_id_hash=hash_user_id("feature-contract-user"),
        channel=UserChannel.WEB,
        locale="en",
        authenticated=True,
        metadata={"provider": "test"},
    )

    async def authenticated_session() -> UserSession:
        return session

    async def authenticated_context() -> RequestContext:
        return RequestContext(
            request_id="feature-contract-request",
            locale="en",
            channel=UserChannel.WEB,
            session=session,
            client_ip_hash="feature-contract-ip",
        )

    services.llm.generate_with_trace = fake_generation  # type: ignore[method-assign]
    app.state.service_container = services
    app.dependency_overrides[require_authenticated_session] = authenticated_session
    app.dependency_overrides[get_request_context] = authenticated_context
    return app


def _sse_events(body: str) -> list[dict]:
    return [
        json.loads(line.removeprefix("data: "))
        for line in body.splitlines()
        if line.startswith("data: ")
    ]


@pytest.mark.asyncio
async def test_core_feature_routes_have_working_authenticated_contracts() -> None:
    app = _app_with_authenticated_test_session()
    transport = httpx.ASGITransport(app=app)
    headers = {"X-MindPal-Channel": "web"}

    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            for path in ("/api/health", "/api/health/live", "/api/health/ready"):
                response = await client.get(path)
                assert response.status_code == 200, (path, response.text)
                assert response.headers.get("x-request-id")

            rag_diagnostic = await client.get("/api/rag/health", headers=headers)
            assert rag_diagnostic.status_code == 403
            assert rag_diagnostic.json()["code"] == "admin_access_required"

            profile = await client.get("/api/user/profile", headers=headers)
            assert profile.status_code == 200
            assert profile.json()["profile"]["preferences"]["locale"] == "auto"

            updated_profile = await client.patch(
                "/api/user/profile",
                headers=headers,
                json={"preferences": {"locale": "ar", "preferred_name": "Mira", "gender": "female"}},
            )
            assert updated_profile.status_code == 200, updated_profile.text
            assert updated_profile.json()["profile"]["preferences"]["preferred_name"] == "Mira"

            memory = await client.get("/api/memory/v3", headers=headers)
            assert memory.status_code == 200, memory.text
            assert memory.json()["loaded"] is True

            tools = await client.get("/api/tools/list", headers=headers)
            assert tools.status_code == 200, tools.text
            assert isinstance(tools.json().get("tools"), list)

            current_time = await client.post(
                "/api/tools/execute",
                headers=headers,
                json={"tool": "current_time", "args": {}},
            )
            assert current_time.status_code == 200, current_time.text
            assert current_time.json()["tool"] == "current_time"
            assert current_time.json().get("result")

            tool_batch = await client.post(
                "/api/tools/batch",
                headers=headers,
                json={"calls": [{"tool": "current_time", "args": {}}, {"tool": "unknown_tool", "args": {}}]},
            )
            assert tool_batch.status_code == 200, tool_batch.text
            assert len(tool_batch.json()["results"]) == 2
            assert tool_batch.json()["results"][1]["error"]

            tts_health = await client.get("/api/tts/health", headers=headers)
            assert tts_health.status_code == 200, tts_health.text
            tts_safe_policy = await client.post(
                "/api/tts/policy",
                headers=headers,
                json={"text": "A calm reminder to breathe", "locale": "en", "safety_level": "safe"},
            )
            assert tts_safe_policy.status_code == 200, tts_safe_policy.text
            assert tts_safe_policy.json()["browser_fallback_allowed"] is True
            tts_crisis_policy = await client.post(
                "/api/tts/policy",
                headers=headers,
                json={"text": "Stay with a trusted person", "locale": "ar", "safety_level": "self_harm_imminent"},
            )
            assert tts_crisis_policy.status_code == 200, tts_crisis_policy.text
            assert tts_crisis_policy.json()["external_tts_allowed"] is False

            crisis = await client.post(
                "/api/safety/render-crisis-response",
                headers=headers,
                json={"locale": "ar"},
            )
            assert crisis.status_code == 200, crisis.text
            assert crisis.json()["locale"] == "ar"
            assert crisis.json()["body"]

            safety = await client.post(
                "/api/safety/classify",
                headers={**headers, "X-Request-ID": "feature-safety-ar"},
                json={"text": "أنا هأذي نفسي", "locale": "ar"},
            )
            assert safety.status_code == 200, safety.text
            assert safety.json()["bypass_llm"] is True

            chat_payload = {
                "message": "I feel stressed about tomorrow.",
                "history": [],
                "metadata": {"locale": "en", "channel": "web", "client_request_id": "feature-chat-1"},
            }
            chat = await client.post("/api/chat", headers=headers, json=chat_payload)
            assert chat.status_code == 200, chat.text
            assert chat.json()["provider_used"] == "feature-contract-fake"
            assert chat.json()["reply"]

            chat_replay = await client.post("/api/chat", headers=headers, json=chat_payload)
            assert chat_replay.status_code == 200, chat_replay.text
            assert chat_replay.json()["reply"] == chat.json()["reply"]

            streamed = await client.post(
                "/api/chat/stream",
                headers=headers,
                json={
                    **chat_payload,
                    "metadata": {"locale": "en", "channel": "web", "client_request_id": "feature-stream-1"},
                    "stream": True,
                },
            )
            assert streamed.status_code == 200, streamed.text
            assert streamed.headers["content-type"].startswith("text/event-stream")
            events = _sse_events(streamed.text)
            assert "".join(event.get("text", "") for event in events)
            assert any(event.get("type") == "metadata" for event in events)



@pytest.mark.asyncio
async def test_chat_store_contract_preserves_order_and_deletes_cleanly() -> None:
    app = _app_with_authenticated_test_session()
    transport = httpx.ASGITransport(app=app)
    headers = {"X-MindPal-Channel": "web"}
    messages = [
        {"role": "User", "text": "First", "message_id": "first", "created_at": "2026-01-01T00:00:00Z"},
        {"role": "MindPal", "text": "Second", "message_id": "second", "created_at": "2026-01-01T00:00:01Z"},
    ]

    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            replaced = await client.put("/api/chats/current", headers=headers, json={"messages": messages})
            assert replaced.status_code == 200, replaced.text
            assert len(replaced.json()["chat"]["messages"]) == 2

            loaded = await client.get("/api/chats/current", headers=headers)
            assert loaded.status_code == 200, loaded.text
            assert [item["message_id"] for item in loaded.json()["chat"]["messages"]] == ["first", "second"]

            deleted = await client.delete("/api/chats/current", headers=headers)
            assert deleted.status_code == 200, deleted.text
            after_delete = await client.get("/api/chats/current", headers=headers)
            assert after_delete.status_code == 200
            assert after_delete.json()["chat"]["messages"] == []


@pytest.mark.asyncio
async def test_feature_routes_fail_closed_for_malformed_or_unavailable_inputs() -> None:
    app = _app_with_authenticated_test_session()
    transport = httpx.ASGITransport(app=app)
    headers = {"X-MindPal-Channel": "web"}

    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            malformed_chat = await client.post("/api/chat", headers=headers, json={"message": ""})
            assert malformed_chat.status_code == 422


            unauthenticated_app = create_app(_settings())
            unauth_transport = httpx.ASGITransport(app=unauthenticated_app)
            async with unauthenticated_app.router.lifespan_context(unauthenticated_app):
                async with httpx.AsyncClient(transport=unauth_transport, base_url="http://testserver") as unauth_client:
                    denied_profile = await unauth_client.get("/api/user/profile")
                    denied_memory = await unauth_client.get("/api/memory/v3")
                    assert denied_profile.status_code == 401
                    assert denied_memory.status_code == 401


@pytest.mark.asyncio
async def test_brain_routes_project_memory_v3_and_keep_context_bounded() -> None:
    from backend.models.memory import (
        MemoryCategory,
        MemoryGraph,
        MemorySensitivity,
        MemorySource,
        make_memory_atom,
    )

    app = _app_with_authenticated_test_session()
    transport = httpx.ASGITransport(app=app)
    headers = {"X-MindPal-Channel": "web"}
    user_hash = hash_user_id("feature-contract-user")
    goal = make_memory_atom(
        user_id_hash=user_hash,
        category=MemoryCategory.GOALS,
        value="Maintain a steady sleep routine before demanding deadlines",
        confidence=0.91,
        source=MemorySource.MANUAL,
        sensitivity=MemorySensitivity.MEDIUM,
        pinned=True,
    )
    pattern = make_memory_atom(
        user_id_hash=user_hash,
        category=MemoryCategory.PATTERNS,
        value="Deadline pressure can affect sleep quality",
        confidence=0.82,
        source=MemorySource.CHAT_EXTRACTION,
        sensitivity=MemorySensitivity.MEDIUM,
    )
    restricted = make_memory_atom(
        user_id_hash=user_hash,
        category=MemoryCategory.SAFETY_CONTEXT,
        value="Restricted safety context must not appear in standard Brain views",
        confidence=0.9,
        source=MemorySource.MANUAL,
        sensitivity=MemorySensitivity.HIGH,
    )
    graph = MemoryGraph(user_id_hash=user_hash, atoms=[goal, pattern, restricted])

    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            saved = await client.put(
                "/api/memory/v3",
                headers=headers,
                json={"graph": graph.model_dump(mode="json"), "expected_version": 1},
            )
            assert saved.status_code == 200, saved.text
            graph_version = saved.json()["version"]

            overview = await client.get("/api/brain/overview", headers=headers)
            assert overview.status_code == 200, overview.text
            assert overview.json()["visible_node_count"] == 2
            assert overview.json()["pending_review_count"] == 0

            global_map = await client.get("/api/brain/map", headers=headers)
            assert global_map.status_code == 200, global_map.text
            map_ids = {item["id"] for item in global_map.json()["nodes"]}
            assert {goal.id, pattern.id}.issubset(map_ids)
            assert restricted.id not in map_ids

            edge = await client.post(
                "/api/brain/edges",
                headers=headers,
                json={
                    "source_atom_id": pattern.id,
                    "target_atom_id": goal.id,
                    "relation": "affects",
                    "confidence": 0.86,
                    "expected_version": graph_version,
                },
            )
            assert edge.status_code == 201, edge.text
            edge_id = edge.json()["edge"]["id"]

            focus = await client.get(f"/api/brain/nodes/{goal.id}", headers=headers)
            assert focus.status_code == 200, focus.text
            assert focus.json()["node"]["id"] == goal.id
            assert focus.json()["backlinks"][0]["id"] == edge_id

            planned = await client.post(
                "/api/brain/context-plan",
                headers=headers,
                json={"query": "How can I keep a better sleep routine when deadlines are close?", "intent": "goal_planning"},
            )
            assert planned.status_code == 200, planned.text
            payload = planned.json()
            assert payload["candidate_count"] <= 24
            assert len(payload["nodes"]) <= 6
            assert len(payload["evidence"]) <= 2
            assert len(payload["edges"]) <= 8
            assert goal.id in {item["id"] for item in payload["nodes"]}

            hidden = await client.get(f"/api/brain/nodes/{restricted.id}", headers=headers)
            assert hidden.status_code == 404
