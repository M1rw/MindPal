# tests/unit/platform/test_memory_write.py — Durable memory writes after a chat turn

from __future__ import annotations

import json
import logging

import pytest
from fastapi.testclient import TestClient

from backend.domain.chat.orchestrator import ChatOrchestrator
from backend.domain.memory.extract import can_persist_user_memory, extract_atoms_from_turn
from backend.domain.memory.graph import MemoryAtom, MemoryGraph, format_memory_receipt
from backend.domain.quota.quota import QuotaService
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


def _graph_blob(graph: MemoryGraph) -> str:
    return " ".join(atom.value for atom in graph.atoms).lower()


def _memory_events(chunks: list[dict]) -> list[dict]:
    return [chunk["memory"] for chunk in chunks if isinstance(chunk.get("memory"), dict)]


def _parse_sse_events(body: str) -> list[dict]:
    events: list[dict] = []
    for line in body.splitlines():
        if not line.startswith("data: ") or line == "data: [DONE]":
            continue
        payload = json.loads(line[6:])
        if isinstance(payload, dict):
            events.append(payload)
    return events


def test_extract_stable_name_and_goal_skips_bland_and_crisis():
    atoms = extract_atoms_from_turn("My name is Sarah. My goal is to improve my sleep.")
    blob = " ".join(atom.value for atom in atoms).lower()
    assert "sarah" in blob
    assert "sleep" in blob
    assert extract_atoms_from_turn("ok") == []
    assert extract_atoms_from_turn("thanks") == []
    crisis = extract_atoms_from_turn("I want to end my life")
    assert crisis == []
    assert not any("end my life" in atom.value.lower() for atom in crisis)


def test_guest_shared_key_is_not_durable():
    assert can_persist_user_memory("usr_mem_write") is True
    assert can_persist_user_memory("usr_anon_default") is False
    assert can_persist_user_memory("usr_anon_pool") is False
    assert can_persist_user_memory("") is False
    assert can_persist_user_memory("gst_0123456789abcdef0123456789abcdef") is False
    assert can_persist_user_memory("guest") is False


@pytest.mark.asyncio
async def test_turn_persists_stable_facts_for_the_next_turn(caplog):
    llm = RecordingLLM()
    store = InMemoryStore()
    orch = ChatOrchestrator(llm_gateway=llm, store=store, quota_service=QuotaService(store))
    chunks: list[dict] = []
    with caplog.at_level(logging.INFO, logger="mindpal.chat"):
        async for chunk in orch.execute_turn_stream(
            user_id_hash="usr_mem_write",
            message="My name is Sarah. My goal is to improve my sleep.",
            consume_quota=False,
            request_id="req_mem_write",
        ):
            chunks.append(chunk)

    graph = orch.memory_service.get_memory_graph("usr_mem_write")
    blob = _graph_blob(graph)
    assert "sarah" in blob
    assert "sleep" in blob
    assert "my name is sarah. my goal is to improve my sleep." not in blob
    logs = " ".join(record.getMessage() for record in caplog.records)
    assert "My name is Sarah" not in logs
    assert "improve my sleep" not in logs.lower()
    receipts = _memory_events(chunks)
    assert len(receipts) == 1
    saved = receipts[0]["saved"]
    assert receipts[0]["count"] == len(saved)
    assert len(saved) >= 2
    types = {item["type"] for item in saved}
    texts = " ".join(item["text"] for item in saved).lower()
    assert "profile" in types
    assert "goals" in types
    assert "sarah" in texts
    assert "sleep" in texts
    assert all(item["id"] and item["text"] for item in saved)
    assert all("user_id" not in item for item in saved)
    assert all(chunk.get("user_id_hash") is None for chunk in chunks if chunk.get("memory"))

    async for _ in orch.execute_turn_stream(
        user_id_hash="usr_mem_write",
        message="how has my week been?",
        consume_quota=False,
    ):
        pass
    instruction = llm.calls[1]["system_instruction"]
    assert "Sarah" in instruction
    assert "sleep" in instruction.lower()
    assert "Known user memory" in instruction


@pytest.mark.asyncio
async def test_bland_turn_does_not_pollute_the_graph():
    store = InMemoryStore()
    orch = ChatOrchestrator(
        llm_gateway=RecordingLLM(),
        store=store,
        quota_service=QuotaService(store),
    )
    chunks: list[dict] = []
    async for chunk in orch.execute_turn_stream(
        user_id_hash="usr_mem_bland",
        message="ok",
        consume_quota=False,
    ):
        chunks.append(chunk)
    graph = orch.memory_service.get_memory_graph("usr_mem_bland")
    assert graph.atoms == []
    assert graph.summary == ""
    assert _memory_events(chunks) == []


@pytest.mark.asyncio
async def test_crisis_turn_does_not_store_crisis_text():
    store = InMemoryStore()
    orch = ChatOrchestrator(store=store, quota_service=QuotaService(store))
    chunks: list[dict] = []
    async for chunk in orch.execute_turn_stream(
        user_id_hash="usr_mem_crisis",
        message="I want to end my life",
        consume_quota=False,
    ):
        chunks.append(chunk)
        assert chunk.get("is_crisis") is True
    graph = orch.memory_service.get_memory_graph("usr_mem_crisis")
    blob = _graph_blob(graph)
    assert graph.atoms == []
    assert "end my life" not in blob
    assert "Lifeline" not in blob
    assert _memory_events(chunks) == []


@pytest.mark.asyncio
async def test_anonymous_default_user_does_not_write_a_global_graph():
    store = InMemoryStore()
    orch = ChatOrchestrator(
        llm_gateway=RecordingLLM(),
        store=store,
        quota_service=QuotaService(store),
    )
    chunks: list[dict] = []
    async for chunk in orch.execute_turn_stream(
        user_id_hash="usr_anon_default",
        message="My name is Sarah. My goal is to improve my sleep.",
        consume_quota=False,
    ):
        chunks.append(chunk)
    graph = orch.memory_service.get_memory_graph("usr_anon_default")
    assert graph.atoms == []
    receipts = _memory_events(chunks)
    assert len(receipts) == 1
    texts = " ".join(item["text"] for item in receipts[0]["saved"]).lower()
    assert "sarah" in texts
    assert "sleep" in texts
    assert store.get_document("memory_graphs", "usr_anon_default") in (None, {})


@pytest.mark.asyncio
async def test_empty_model_output_does_not_write_memory():
    store = InMemoryStore()
    orch = ChatOrchestrator(
        llm_gateway=EmptyLLM(),
        store=store,
        quota_service=QuotaService(store),
    )
    chunks: list[dict] = []
    async for chunk in orch.execute_turn_stream(
        user_id_hash="usr_mem_empty",
        message="My name is Sarah",
        consume_quota=False,
    ):
        chunks.append(chunk)
    assert orch.memory_service.get_memory_graph("usr_mem_empty").atoms == []
    assert _memory_events(chunks) == []


@pytest.mark.asyncio
async def test_merge_updates_preferred_name_without_replacing_the_graph():
    store = InMemoryStore()
    orch = ChatOrchestrator(
        llm_gateway=RecordingLLM(),
        store=store,
        quota_service=QuotaService(store),
    )
    orch.memory_service.save_memory_graph(
        MemoryGraph(
            user_id_hash="usr_mem_merge",
            summary="Prefers evening walks.",
            atoms=[MemoryAtom(id="g1", category="goals", value="Improve sleep", confidence=1.0)],
        )
    )
    async for _ in orch.execute_turn_stream(
        user_id_hash="usr_mem_merge",
        message="Please call me Samira",
        consume_quota=False,
    ):
        pass
    graph = orch.memory_service.get_memory_graph("usr_mem_merge")
    blob = _graph_blob(graph)
    assert "samira" in blob
    assert "improve sleep" in blob
    assert graph.summary == "Prefers evening walks."
    assert len([a for a in graph.atoms if a.id == "profile:preferred_name"]) == 1


def test_receipt_lists_short_display_text_without_the_full_turn():
    receipt = format_memory_receipt(
        [
            MemoryAtom(id="profile:preferred_name", category="profile", value="Preferred name: Sarah"),
            MemoryAtom(id="goals:sleep", category="goals", value="Improve my sleep"),
        ]
    )
    assert receipt["count"] == 2
    assert receipt["saved"][0] == {
        "id": "profile:preferred_name",
        "type": "profile",
        "text": "Preferred name: Sarah",
    }
    blob = json.dumps(receipt)
    assert "My name is" not in blob
    assert "user_id" not in blob


def test_sse_memory_receipt_on_live_route(monkeypatch):
    from backend.http import chat as chat_http

    llm = RecordingLLM()
    store = InMemoryStore()
    orch = ChatOrchestrator(llm_gateway=llm, store=store, quota_service=QuotaService(store))
    monkeypatch.setattr(chat_http, "orchestrator", orch)
    client = TestClient(create_app(serve_frontend=False))
    res = client.post(
        "/api/chat/stream",
        json={"message": "My name is Sarah. I prefer concise replies."},
        headers={"Authorization": "Bearer dev_mem_receipt"},
    )
    assert res.status_code == 200
    events = _parse_sse_events(res.text)
    receipts = [event["memory"] for event in events if "memory" in event]
    assert len(receipts) == 1
    saved = receipts[0]["saved"]
    assert receipts[0]["count"] == len(saved)
    assert saved
    texts = " ".join(item["text"] for item in saved).lower()
    assert "sarah" in texts
    assert all(set(item) <= {"id", "type", "text"} for item in saved)
    assert "user_id_hash" not in json.dumps(receipts[0])
    assert "My name is Sarah. I prefer concise replies." not in json.dumps(receipts[0])


def test_sse_omits_memory_receipt_when_nothing_saved(monkeypatch):
    from backend.http import chat as chat_http

    store = InMemoryStore()
    orch = ChatOrchestrator(
        llm_gateway=RecordingLLM(),
        store=store,
        quota_service=QuotaService(store),
    )
    monkeypatch.setattr(chat_http, "orchestrator", orch)
    client = TestClient(create_app(serve_frontend=False))
    bland = client.post(
        "/api/chat/stream",
        json={"message": "thanks"},
        headers={"Authorization": "Bearer dev_mem_silent"},
    )
    assert bland.status_code == 200
    assert _memory_events(_parse_sse_events(bland.text)) == []

    guest = client.post(
        "/api/chat/stream",
        json={"message": "My name is Sarah. I prefer concise replies."},
    )
    assert guest.status_code == 200
    guest_receipts = _memory_events(_parse_sse_events(guest.text))
    assert len(guest_receipts) == 1
    texts = " ".join(item["text"] for item in guest_receipts[0]["saved"]).lower()
    assert "sarah" in texts
    assert orch.memory_service.get_memory_graph("usr_anon_default").atoms == []
    assert store.get_document("memory_graphs", "usr_anon_default") in (None, {})


def test_two_guest_graph_keys_do_not_share_atoms():
    from backend.domain.memory.graph import MemoryGraphService

    store = InMemoryStore()
    service = MemoryGraphService(store)
    first = "gst_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    second = "gst_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    service.merge_atoms(
        first,
        [MemoryAtom(id="profile:preferred_name", category="profile", value="Preferred name: Ada")],
    )
    service.merge_atoms(
        second,
        [MemoryAtom(id="profile:preferred_name", category="profile", value="Preferred name: Beau")],
    )
    ada = _graph_blob(service.get_memory_graph(first))
    beau = _graph_blob(service.get_memory_graph(second))
    assert "ada" in ada
    assert "beau" in beau
    assert "beau" not in ada
    assert "ada" not in beau
    assert service.get_memory_graph("usr_anon_default").atoms == []


def test_guest_http_writes_do_not_touch_shared_anon_graph(monkeypatch):
    from backend.http import memory as memory_http

    store = InMemoryStore()
    service = memory_http.MemoryGraphService(store)
    monkeypatch.setattr(memory_http, "memory_service", service)
    client = TestClient(create_app(serve_frontend=False))

    put = client.put(
        "/api/memory/graph",
        json={"atoms": [{"id": "profile:preferred_name", "value": "Preferred name: Eve"}]},
    )
    assert put.status_code == 401

    delete = client.delete("/api/memory/graph/items/profile:preferred_name")
    assert delete.status_code == 401

    patch = client.patch(
        "/api/memory/graph/items/profile:preferred_name",
        json={"value": "Preferred name: Eve"},
    )
    assert patch.status_code == 401

    loaded = client.get("/api/memory/graph")
    assert loaded.status_code == 200
    body = loaded.json()
    assert body["atoms"] == []
    assert "usr_anon_default" not in json.dumps(body)
    assert service.get_memory_graph("usr_anon_default").atoms == []
    assert store.get_document("memory_graphs", "usr_anon_default") in (None, {})


def test_extract_atoms_expanded_coverage():
    from backend.domain.memory.extract import extract_atoms_from_transcript

    # Preferred name variants
    atoms_name = extract_atoms_from_turn("I'm Dimar.")
    assert any(a.value == "Preferred name: Dimar" for a in atoms_name)

    atoms_name_alt = extract_atoms_from_turn("My name's Alex.")
    assert any(a.value == "Preferred name: Alex" for a in atoms_name_alt)

    # Negative: Common states should not be extracted as names
    atoms_neg = extract_atoms_from_turn("I'm tired and I am really hungry.")
    assert not any("Preferred name:" in a.value for a in atoms_neg)

    # Social connections
    atoms_people = extract_atoms_from_turn("My friend Farha and my sister Sarah told me to call.")
    vals = [a.value for a in atoms_people]
    assert any("Friend is Farha" in v for v in vals)
    assert any("Sister is Sarah" in v for v in vals)

    # Pets
    atoms_pet = extract_atoms_from_turn("My dog Max has been keeping me company.")
    assert any("Pet is Max" in a.value for a in atoms_pet)

    # Sleep and stress problems
    atoms_prob = extract_atoms_from_turn("I couldn't sleep last night because school has been so stressful.")
    vals = [a.value for a in atoms_prob]
    assert "Trouble sleeping" in vals
    assert "School or studies have been stressful" in vals

    # Life context: Occupation, Education, Location
    atoms_life = extract_atoms_from_turn("I work as a software engineer and I live in Paris.")
    vals = [a.value for a in atoms_life]
    assert any("Works as software engineer" in v for v in vals)
    assert any("Based in Paris" in v for v in vals)

    atoms_study = extract_atoms_from_turn("I'm studying computer science.")
    assert any("Studying computer science" in a.value for a in atoms_study)

    # Multi-sentence voice transcript
    transcript = (
        "Hello MindPal! I'm Dimar. I have a friend named Farha. "
        "I haven't been able to sleep lately because work has been stressful. "
        "I'm feeling really anxious about everything."
    )
    atoms_tx = extract_atoms_from_transcript(transcript)
    tx_vals = " ".join(a.value for a in atoms_tx).lower()
    assert "dimar" in tx_vals
    assert "farha" in tx_vals
    assert "trouble sleeping" in tx_vals
    assert "stressful" in tx_vals
    assert "anxiety" in tx_vals


def test_empty_summary_rebuilt_on_get_memory_summary(monkeypatch):
    from backend.http import memory as memory_http

    monkeypatch.setenv("ENVIRONMENT", "test")
    store = InMemoryStore()
    service = memory_http.MemoryGraphService(store)
    # Save graph with atoms but NO summary
    service.save_memory_graph(
        MemoryGraph(
            user_id_hash="usr_mem_summary",
            summary="",
            atoms=[
                MemoryAtom(id="profile:preferred_name", category="profile", value="Preferred name: Dimar"),
                MemoryAtom(id="patterns:sleep", category="patterns", value="Trouble sleeping"),
            ],
        )
    )
    monkeypatch.setattr(memory_http, "memory_service", service)
    client = TestClient(create_app(serve_frontend=False))
    resp = client.get("/api/memory/summary", headers={"Authorization": "Bearer dev_mem_summary"})
    assert resp.status_code == 200
    data = resp.json()
    assert "Profile: Preferred name: Dimar" in data["summary"]
    assert "Patterns: Trouble sleeping" in data["summary"]

