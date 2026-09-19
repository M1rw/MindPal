# tests/unit/platform/test_chat_pipeline.py — Chat stream contract, quota, history, insights

from __future__ import annotations

import asyncio
import json
import logging

import pytest
from fastapi.testclient import TestClient

from backend.core.errors import AppError
from backend.domain.chat.history import normalize_history
from backend.domain.chat.orchestrator import ChatOrchestrator, client_context_note, detect_cognitive_strategy, personalization_note, provider_model_for_tier
from backend.http.chat import ClientContext
from backend.tools import ClientContextTools, ToolContext, load_tool_catalog
from backend.domain.identity.identity import IdentityService
from backend.domain.memory.graph import MemoryAtom, MemoryGraph
from backend.domain.quota.quota import QuotaService
from backend.infra.llm.gateway import LLMGatewayError
from backend.infra.store.store import InMemoryStore
from backend.main import create_app


class RecordingLLM:
    def __init__(self, text: str = "Hello there") -> None:
        self.calls: list[dict] = []
        self.text = text

    async def generate_stream(self, **kwargs):
        self.calls.append(kwargs)
        yield self.text


class EmptyLLM:
    async def generate_stream(self, **kwargs):
        if False:
            yield "x"
        return


class FailingLLM:
    async def generate_stream(self, **kwargs):
        raise LLMGatewayError(
            "unavailable",
            "MindPal hit a connection issue while generating this response. Please retry this message.",
        )
        yield "x"


class SlowLLM:
    cancelled = False

    async def generate_stream(self, **kwargs):
        try:
            yield "Hi "
            await asyncio.sleep(30)
            yield "there"
        except (asyncio.CancelledError, GeneratorExit):
            SlowLLM.cancelled = True
            raise
        finally:
            if SlowLLM.cancelled is False:
                SlowLLM.cancelled = True


def test_personalization_maps_frontend_warmth_keys():
    note = personalization_note({
        "baseStyle": "concise",
        "warmth": "direct",
        "useHeadersLists": False,
        "emojiSupport": False,
    })
    assert "concise" in note.lower()
    assert "plain-spoken" in note
    assert "emojis" in note.lower()
    _, directive = detect_cognitive_strategy("hello", personalization={"warmth": "neutral"})
    assert "grounded, even tone" in directive
    assert "clinical posture" not in directive.lower()


def test_standard_and_pro_share_the_same_provider_model():
    assert provider_model_for_tier("standard") == provider_model_for_tier("pro") == "gemini-2.5-flash"
    assert "clinical" not in detect_cognitive_strategy("hello", model="pro")[1].lower()


def test_client_context_supplies_local_time_and_approximate_location() -> None:
    note = client_context_note({
        "timezone": "America/New_York",
        "location": {"latitude": 40.7128, "longitude": -74.0060},
    })
    assert "America/New_York" in note
    assert "current local date and time" in note.lower()
    assert "40.7128, -74.0060" in note
    assert "exact address" in note


def test_client_context_discards_invalid_timezone() -> None:
    context = ClientContext(timezone="not/a-timezone")
    assert context.timezone is None


def test_context_tools_are_available_outside_the_chat_transport() -> None:
    result = ClientContextTools.current_time(ToolContext(timezone="UTC"))
    assert "Current local date and time:" in result


def test_tool_catalog_drives_context_prompt() -> None:
    catalog = load_tool_catalog()
    assert {tool["name"] for tool in catalog} >= {"current_time", "user_location"}
    note = ClientContextTools.system_note(ToolContext(timezone="UTC"))
    assert "Returns the user's current local date and time" in note
    assert "The user asks what time it is." in note


def test_history_strips_trailing_current_user_before_slice():
    current = "what was my last message?"
    history = [{"role": "user", "content": f"turn {i}"} for i in range(40)]
    history.append({"role": "user", "content": current})
    normalized = normalize_history(history, current, max_turns=30)
    assert len(normalized) == 30
    assert normalized[-1]["content"] == "turn 39"
    assert all(item["content"] != current for item in normalized)


def test_history_keeps_prior_turns_when_client_omits_current():
    history = [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "hi"},
    ]
    normalized = normalize_history(history, "how many messages?", max_turns=30)
    assert normalized == history


@pytest.mark.asyncio
async def test_history_and_personalization_reach_the_provider():
    llm = RecordingLLM()
    store = InMemoryStore()
    orch = ChatOrchestrator(llm_gateway=llm, store=store, quota_service=QuotaService(store))
    chunks = []
    async for chunk in orch.execute_turn_stream(
        user_id_hash="usr_hist",
        message="how many messages?",
        history=[
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi"},
            {"role": "user", "content": "how many messages?"},
        ],
        personalization={"baseStyle": "detailed", "warmth": "direct"},
        consume_quota=False,
        request_id="req_hist",
    ):
        chunks.append(chunk)
    assert llm.calls
    call = llm.calls[0]
    assert call["history"] == [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "hi"},
    ]
    assert "plain-spoken" in call["system_instruction"]
    assert "structured depth" in call["system_instruction"]
    texts = "".join(str(c.get("text") or "") for c in chunks)
    assert "Hello there" in texts
    assert any(c.get("request_id") == "req_hist" for c in chunks)


@pytest.mark.asyncio
async def test_safety_overrides_personalization_and_skips_llm():
    llm = RecordingLLM()
    orch = ChatOrchestrator(llm_gateway=llm, store=InMemoryStore(), quota_service=QuotaService(InMemoryStore()))
    chunks = []
    async for chunk in orch.execute_turn_stream(
        user_id_hash="usr_safe",
        message="I want to end my life",
        personalization={"warmth": "direct"},
        consume_quota=False,
    ):
        chunks.append(chunk)
    assert llm.calls == []
    assert chunks[0]["strategy_used"] == "Safety Shield"
    assert "Lifeline" in chunks[0]["text"]


@pytest.mark.asyncio
async def test_empty_model_output_is_a_structured_error():
    orch = ChatOrchestrator(llm_gateway=EmptyLLM(), store=InMemoryStore(), quota_service=QuotaService(InMemoryStore()))
    chunks = [chunk async for chunk in orch.execute_turn_stream(
        user_id_hash="usr_empty",
        message="hello",
        consume_quota=False,
        request_id="req_empty",
    )]
    errors = [c["error"] for c in chunks if c.get("error")]
    assert errors
    assert errors[0]["code"] == "unavailable"
    assert "retry" in errors[0]["message"].lower()


@pytest.mark.asyncio
async def test_provider_failure_is_a_structured_error():
    orch = ChatOrchestrator(llm_gateway=FailingLLM(), store=InMemoryStore(), quota_service=QuotaService(InMemoryStore()))
    chunks = [chunk async for chunk in orch.execute_turn_stream(
        user_id_hash="usr_fail",
        message="hello",
        consume_quota=False,
    )]
    assert chunks[-1]["error"]["code"] == "unavailable"
    assert "connection issue" in chunks[-1]["error"]["message"].lower()


@pytest.mark.asyncio
async def test_disconnect_cancels_provider_and_refunds_quota():
    SlowLLM.cancelled = False
    store = InMemoryStore()
    quota = QuotaService(store, limit_5h=5, limit_week=20)
    orch = ChatOrchestrator(llm_gateway=SlowLLM(), store=store, quota_service=quota)
    preflight = orch.preflight_turn(user_id_hash="usr_abort", message="hello")
    assert preflight.reservation is not None
    assert preflight.reservation.credits_5h == 1

    agen = orch.execute_turn_stream(
        user_id_hash="usr_abort",
        message="hello",
        preflight=preflight,
        consume_quota=False,
        request_id="req_abort",
    )
    first = await agen.__anext__()
    assert "usage" in first or first.get("text")
    if "usage" in first:
        second = await agen.__anext__()
        assert second.get("text")
    await agen.aclose()
    assert SlowLLM.cancelled is True
    assert quota.snapshot("usr_abort").credits_5h == 0


def test_quota_preflight_http_429(monkeypatch):
    from backend.http import chat as chat_http

    store = InMemoryStore()
    orch = ChatOrchestrator(
        llm_gateway=RecordingLLM(),
        store=store,
        quota_service=QuotaService(store, limit_5h=1, limit_week=10),
    )
    monkeypatch.setattr(chat_http, "orchestrator", orch)
    client = TestClient(create_app(serve_frontend=False))
    headers = {"Authorization": "Bearer dev_quota_pipe"}
    first = client.post("/api/chat/stream", json={"message": "hello"}, headers=headers)
    assert first.status_code == 200
    second = client.post("/api/chat/stream", json={"message": "hello again"}, headers=headers)
    assert second.status_code == 429
    body = second.json()
    assert body["code"] == "quota_exceeded"
    assert body["details"]["limit_5h"] == 1


def test_pro_preflight_costs_two_credits():
    store = InMemoryStore()
    orch = ChatOrchestrator(
        llm_gateway=RecordingLLM(),
        store=store,
        quota_service=QuotaService(store, limit_5h=3, limit_week=10),
    )
    standard = orch.preflight_turn(user_id_hash="usr_pro_cost", message="hello", model="standard")
    assert standard.cost == 1
    assert standard.reservation is not None
    assert standard.reservation.credits_5h == 1
    pro = orch.preflight_turn(user_id_hash="usr_pro_cost", message="hello again", model="pro")
    assert pro.cost == 2
    assert pro.reservation is not None
    assert pro.reservation.credits_5h == 3
    blocked = orch.preflight_turn(user_id_hash="usr_pro_cost", message="one more", model="standard")
    assert blocked.error is not None
    assert blocked.error.code == "quota_exceeded"


def test_pro_http_reserves_two_credits(monkeypatch):
    from backend.http import chat as chat_http

    store = InMemoryStore()
    orch = ChatOrchestrator(
        llm_gateway=RecordingLLM(),
        store=store,
        quota_service=QuotaService(store, limit_5h=2, limit_week=10),
    )
    monkeypatch.setattr(chat_http, "orchestrator", orch)
    client = TestClient(create_app(serve_frontend=False))
    headers = {"Authorization": "Bearer dev_quota_pro"}
    first = client.post("/api/chat/stream", json={"message": "hello", "model": "pro"}, headers=headers)
    assert first.status_code == 200
    second = client.post("/api/chat/stream", json={"message": "hello again", "model": "standard"}, headers=headers)
    assert second.status_code == 429
    assert second.json()["code"] == "quota_exceeded"


@pytest.mark.asyncio
async def test_pro_uses_same_provider_model_without_clinical_claims():
    llm = RecordingLLM()
    store = InMemoryStore()
    orch = ChatOrchestrator(llm_gateway=llm, store=store, quota_service=QuotaService(store))
    async for _ in orch.execute_turn_stream(
        user_id_hash="usr_tier",
        message="hello there",
        model="standard",
        consume_quota=False,
    ):
        pass
    async for _ in orch.execute_turn_stream(
        user_id_hash="usr_tier",
        message="hello there",
        model="pro",
        consume_quota=False,
    ):
        pass
    assert len(llm.calls) == 2
    assert llm.calls[0]["model"] == llm.calls[1]["model"] == "gemini-2.5-flash"
    pro_instruction = llm.calls[1]["system_instruction"]
    assert "Thorough" in pro_instruction
    assert "clinical" not in pro_instruction.lower()
    assert "therapeutic" not in pro_instruction.lower()


def test_quota_skips_crisis_turns(monkeypatch):

    from backend.http import chat as chat_http

    store = InMemoryStore()
    orch = ChatOrchestrator(
        llm_gateway=RecordingLLM(),
        store=store,
        quota_service=QuotaService(store, limit_5h=1, limit_week=10),
    )
    monkeypatch.setattr(chat_http, "orchestrator", orch)
    client = TestClient(create_app(serve_frontend=False))
    headers = {"Authorization": "Bearer dev_quota_crisis"}
    crisis = client.post("/api/chat/stream", json={"message": "I want to kill myself"}, headers=headers)
    assert crisis.status_code == 200
    assert "Lifeline" in crisis.text
    follow = client.post("/api/chat/stream", json={"message": "I am feeling calmer now"}, headers=headers)
    assert follow.status_code == 200


def test_insights_are_empty_without_mock_clinical_scores():
    client = TestClient(create_app(serve_frontend=False))
    res = client.get("/api/user/insights", headers={"Authorization": "Bearer dev_insights_empty"})
    assert res.status_code == 200
    data = res.json()
    assert data["total_reflections"] == 0
    assert data["reflection_streak_days"] == 0
    assert data["week_active"] == [False, False, False, False, False, False, False]
    assert data["last_active_date"] is None
    blob = json.dumps(data)
    assert "phq9" not in blob.lower()
    assert "gad7" not in blob.lower()
    assert "clinical_scores" not in data


def test_insights_count_real_user_turns():
    store = InMemoryStore()
    identity = IdentityService()
    identity.store = store
    store.set_document(
        "chat_sessions",
        "usr_real",
        {
            "messages": [
                {"role": "user", "content": "hello", "timestamp": "2026-09-14T10:00:00Z"},
                {"role": "assistant", "content": "hi"},
                {"role": "user", "content": "again", "timestamp": "2026-09-14T11:00:00Z"},
            ]
        },
    )
    insights = identity.get_insights("usr_real")
    assert insights["total_reflections"] == 2
    assert insights["reflection_streak_days"] in {0, 1}
    assert insights["last_active_date"] == "2026-09-14"
    assert len(insights["week_active"]) == 7
    assert all(isinstance(flag, bool) for flag in insights["week_active"])
    assert "clinical_scores" not in insights


def test_insights_week_active_marks_this_week_only():
    from datetime import date, timedelta

    today = date.today()
    monday = today - timedelta(days=today.weekday())
    last_monday = monday - timedelta(days=7)
    store = InMemoryStore()
    identity = IdentityService()
    identity.store = store
    store.set_document(
        "chat_sessions",
        "usr_week",
        {
            "messages": [
                {"role": "user", "content": "old", "timestamp": f"{last_monday.isoformat()}T10:00:00Z"},
                {"role": "user", "content": "mon", "timestamp": f"{monday.isoformat()}T10:00:00Z"},
                {"role": "assistant", "content": "ok"},
                {"role": "user", "content": "today", "timestamp": f"{today.isoformat()}T11:00:00Z"},
            ]
        },
    )
    insights = identity.get_insights("usr_week")
    week = insights["week_active"]
    assert week[0] is True
    assert week[today.weekday()] is True
    for index, flag in enumerate(week):
        if index not in {0, today.weekday()}:
            assert flag is False
    assert insights["last_active_date"] == today.isoformat()


def test_sse_includes_usage_and_history_on_live_route(monkeypatch):
    from backend.http import chat as chat_http

    llm = RecordingLLM()
    store = InMemoryStore()
    orch = ChatOrchestrator(llm_gateway=llm, store=store, quota_service=QuotaService(store))
    monkeypatch.setattr(chat_http, "orchestrator", orch)
    client = TestClient(create_app(serve_frontend=False))
    res = client.post(
        "/api/chat/stream",
        json={
            "message": "how many messages?",
            "history": [
                {"role": "user", "content": "hello"},
                {"role": "assistant", "content": "hi"},
                {"role": "user", "content": "how many messages?"},
            ],
            "personalization": {"baseStyle": "concise", "warmth": "warm"},
        },
        headers={"Authorization": "Bearer dev_hist_live"},
    )
    assert res.status_code == 200
    assert res.headers.get("x-request-id")
    events = [json.loads(line[6:]) for line in res.text.splitlines() if line.startswith("data: ") and line != "data: [DONE]"]
    assert any("usage" in event for event in events)
    assert llm.calls[0]["history"][-1]["content"] == "hi"
    assert "Keep replies concise" in llm.calls[0]["system_instruction"]


@pytest.mark.asyncio
async def test_stored_memory_reaches_the_provider():
    llm = RecordingLLM()
    store = InMemoryStore()
    orch = ChatOrchestrator(llm_gateway=llm, store=store, quota_service=QuotaService(store))
    orch.memory_service.save_memory_graph(
        MemoryGraph(
            user_id_hash="usr_mem_prompt",
            summary="Prefers evening walks. Anxious before exams.",
            atoms=[
                MemoryAtom(id="p1", category="people", value="Partner is Alex"),
                MemoryAtom(id="g1", category="goals", value="Improve sleep"),
            ],
        )
    )
    store.set_document("user_profiles", "usr_mem_prompt", {"display_name": "Samira"})
    async for _ in orch.execute_turn_stream(
        user_id_hash="usr_mem_prompt",
        message="how has my week been?",
        consume_quota=False,
    ):
        pass
    instruction = llm.calls[0]["system_instruction"]
    assert "Prefers evening walks" in instruction
    assert "Partner is Alex" in instruction
    assert "Improve sleep" in instruction
    assert "Samira" in instruction
    assert "Do not invent additional personal facts" in instruction


@pytest.mark.asyncio
async def test_empty_memory_does_not_invent_biography(caplog):
    llm = RecordingLLM()
    store = InMemoryStore()
    orch = ChatOrchestrator(llm_gateway=llm, store=store, quota_service=QuotaService(store))
    store.set_document("user_profiles", "usr_nomem", {"display_name": "MindPal User"})
    orch.memory_service.save_memory_graph(
        MemoryGraph(user_id_hash="usr_nomem", summary="User is building a therapeutic reflective space.")
    )
    with caplog.at_level(logging.INFO, logger="mindpal.chat"):
        async for _ in orch.execute_turn_stream(
            user_id_hash="usr_nomem",
            message="hello there",
            consume_quota=False,
            request_id="req_nomem",
        ):
            pass
    instruction = llm.calls[0]["system_instruction"]
    assert "therapeutic reflective" not in instruction.lower()
    assert "user reflective context" not in instruction.lower()
    assert "MindPal User" not in instruction
    assert "Known user memory" not in instruction
    logs = " ".join(record.getMessage() for record in caplog.records)
    assert "therapeutic reflective" not in logs.lower()


@pytest.mark.asyncio
async def test_placeholder_summary_still_injects_real_atoms(caplog):
    llm = RecordingLLM()
    store = InMemoryStore()
    orch = ChatOrchestrator(llm_gateway=llm, store=store, quota_service=QuotaService(store))
    store.set_document(
        "memory_graphs",
        "usr_atoms_only",
        {
            "summary": "User is building a therapeutic reflective space.",
            "atoms": [
                {"id": "a1", "category": "avoid", "value": "Apologetic tone"},
                {"id": "gone", "category": "people", "value": "Old roommate", "status": "deleted"},
            ],
        },
    )
    with caplog.at_level(logging.INFO, logger="mindpal.chat"):
        async for _ in orch.execute_turn_stream(
            user_id_hash="usr_atoms_only",
            message="what do you know about me?",
            consume_quota=False,
        ):
            pass
    instruction = llm.calls[0]["system_instruction"]
    assert "Apologetic tone" in instruction
    assert "Old roommate" not in instruction
    assert "therapeutic reflective" not in instruction.lower()
    logs = " ".join(record.getMessage() for record in caplog.records)
    assert "Apologetic tone" not in logs


def test_sse_includes_stored_memory_on_live_route(monkeypatch):
    from backend.http import chat as chat_http

    llm = RecordingLLM()
    store = InMemoryStore()
    orch = ChatOrchestrator(llm_gateway=llm, store=store, quota_service=QuotaService(store))
    orch.memory_service.save_memory_graph(
        MemoryGraph(
            user_id_hash="usr_mem_live",
            summary="Works late shifts and prefers short check-ins.",
            atoms=[MemoryAtom(id="f1", category="facts", value="Lives with two cats")],
        )
    )
    monkeypatch.setattr(chat_http, "orchestrator", orch)
    client = TestClient(create_app(serve_frontend=False))
    res = client.post(
        "/api/chat/stream",
        json={"message": "what should I do after work?"},
        headers={"Authorization": "Bearer dev_mem_live"},
    )
    assert res.status_code == 200
    instruction = llm.calls[0]["system_instruction"]
    assert "Works late shifts" in instruction
    assert "Lives with two cats" in instruction


@pytest.mark.asyncio
async def test_execute_turn_still_returns_crisis_result():
    orch = ChatOrchestrator(store=InMemoryStore(), quota_service=QuotaService(InMemoryStore()))
    turn = await orch.execute_turn(user_id_hash="usr_test", message="I feel like ending my life")
    assert turn.is_crisis is True
    assert turn.risk_level == "imminent"
    assert "Lifeline" in turn.response_text


def test_empty_message_is_rejected():
    client = TestClient(create_app(serve_frontend=False))
    res = client.post("/api/chat/stream", json={"message": "   "})
    assert res.status_code == 422
    with pytest.raises(AppError):
        raise AppError("quota_exceeded", "wait")
