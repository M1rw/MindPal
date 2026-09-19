# tests/unit/platform/test_grounding.py — Clinical corpus retrieval on chat turns

from __future__ import annotations

import logging

import pytest

from backend.domain.chat.orchestrator import ChatOrchestrator
from backend.domain.grounding.grounding import GroundingService
from backend.domain.quota.quota import QuotaService
from backend.infra.store.store import InMemoryStore


class RecordingLLM:
    def __init__(self, text: str = "Hello there") -> None:
        self.calls: list[dict] = []
        self.text = text

    async def generate_stream(self, **kwargs):
        self.calls.append(kwargs)
        yield self.text


_STUB_IDS = ("grounding_anxiety_54321", "grounding_cbt_reframing")
_STUB_TEXT = (
    "Acknowledge 5 things you can see, 4 things you can touch, 3 things you can hear",
    "Identify automatic cognitive distortions",
)
_CORPUS_SNIPPETS = (
    "Start with one immediate sensory step",
    "Use STOP: Stop, Take a step back",
    "Separate the thought from the facts",
    "25-minute active recall",
    "Frame the boundary as a future rule",
)


class SpyGrounding:
    def __init__(self) -> None:
        self.calls = 0

    def retrieve_context(self, message: str, limit: int = 2):
        self.calls += 1
        return []


def test_relevant_panic_query_retrieves_clinical_unit():
    chunks = GroundingService().retrieve_context("I am having a panic attack and can't breathe")
    assert chunks
    blob = " ".join(f"{c.id} {c.topic} {c.content}" for c in chunks)
    assert any(c.id == "clinical_panic_grounding_54321" for c in chunks)
    assert "Start with one immediate sensory step" in blob
    for stub_id in _STUB_IDS:
        assert stub_id not in blob


def test_unrelated_query_does_not_dump_clinical_text():
    chunks = GroundingService().retrieve_context("What's a simple pasta recipe for dinner?")
    assert chunks == []


def test_empty_query_retrieves_nothing():
    service = GroundingService()
    assert service.retrieve_context("") == []
    assert service.retrieve_context("   ") == []


def test_sadness_does_not_invent_cbt_stub():
    chunks = GroundingService().retrieve_context("I feel sad and down today")
    blob = " ".join(f"{c.id} {c.content}" for c in chunks)
    for stub_id in _STUB_IDS:
        assert stub_id not in blob
    assert "Identify automatic cognitive distortions" not in blob


def test_arabic_relationship_distress_retrieves_boundary_unit():
    chunks = GroundingService().retrieve_context("تعبت من العلاقة وبيقلل مني")
    assert chunks
    blob = " ".join(f"{c.id} {c.topic} {c.content}" for c in chunks)
    assert "clinical_relationship_boundary" in blob
    assert "Frame the boundary as a future rule" in blob


def test_overthinking_retrieves_reframe_unit():
    chunks = GroundingService().retrieve_context("I can't stop thinking and I am assuming everyone hates me")
    assert chunks
    blob = " ".join(c.content for c in chunks)
    assert "Separate the thought from the facts" in blob


@pytest.mark.asyncio
async def test_relevant_query_injects_corpus_into_chat_prompt():
    llm = RecordingLLM()
    orch = ChatOrchestrator(llm_gateway=llm, store=InMemoryStore(), quota_service=QuotaService(InMemoryStore()))
    async for _ in orch.execute_turn_stream(
        user_id_hash="usr_rag_hit",
        message="I am having a panic attack and can't breathe",
        consume_quota=False,
    ):
        pass
    instruction = llm.calls[0]["system_instruction"]
    assert "Technique guidance from the wellness corpus" in instruction
    assert "not diagnosis or treatment" in instruction.lower()
    assert "Start with one immediate sensory step" in instruction
    for stub_id in _STUB_IDS:
        assert stub_id not in instruction
    for stub in _STUB_TEXT:
        assert stub not in instruction


@pytest.mark.asyncio
async def test_unrelated_chat_turn_does_not_inject_clinical_corpus():
    llm = RecordingLLM()
    orch = ChatOrchestrator(llm_gateway=llm, store=InMemoryStore(), quota_service=QuotaService(InMemoryStore()))
    async for _ in orch.execute_turn_stream(
        user_id_hash="usr_rag_miss",
        message="What's a simple pasta recipe for dinner?",
        consume_quota=False,
    ):
        pass
    instruction = llm.calls[0]["system_instruction"]
    assert "Technique guidance from the wellness corpus" not in instruction
    for snippet in _CORPUS_SNIPPETS:
        assert snippet not in instruction
    for stub_id in _STUB_IDS:
        assert stub_id not in instruction


@pytest.mark.asyncio
async def test_crisis_skips_grounding_and_llm():
    llm = RecordingLLM()
    spy = SpyGrounding()
    orch = ChatOrchestrator(
        llm_gateway=llm,
        store=InMemoryStore(),
        quota_service=QuotaService(InMemoryStore()),
        grounding_service=spy,
    )
    chunks = [
        chunk
        async for chunk in orch.execute_turn_stream(
            user_id_hash="usr_rag_crisis",
            message="I want to end my life",
            consume_quota=False,
        )
    ]
    assert llm.calls == []
    assert spy.calls == 0
    assert chunks[0]["strategy_used"] == "Safety Shield"
    assert "Lifeline" in chunks[0]["text"]


@pytest.mark.asyncio
async def test_grounding_logs_counts_not_corpus_or_user_text(caplog):
    llm = RecordingLLM()
    orch = ChatOrchestrator(llm_gateway=llm, store=InMemoryStore(), quota_service=QuotaService(InMemoryStore()))
    message = "I am having a panic attack and can't breathe"
    with caplog.at_level(logging.INFO, logger="mindpal.grounding"):
        async for _ in orch.execute_turn_stream(
            user_id_hash="usr_rag_log",
            message=message,
            consume_quota=False,
            request_id="req_rag_log",
        ):
            pass
    logs = " ".join(record.getMessage() for record in caplog.records)
    assert "grounding_retrieve hits=" in logs
    assert message not in logs
    assert "Start with one immediate sensory step" not in logs
