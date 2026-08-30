# tests/unit/domain/test_memory_domain.py

import pytest
from backend.services.domain.memory import (
    MemoryService,
    build_memory_interactions,
)


def test_memory_service_extraction_and_redaction():
    service = MemoryService()
    text = "My name is Sarah. My email is test@example.com. I feel anxious during exams."

    redacted = service.redact_text(text)
    assert "test@example.com" not in redacted
    assert "[redacted_email]" in redacted

    extraction = service.extract(text)
    assert extraction.preferred_name == "Sarah"
    assert "exams" in extraction.triggers


@pytest.mark.asyncio
async def test_memory_service_compaction_local():
    service = MemoryService()
    interactions = build_memory_interactions(
        user_messages=["My name is Alex.", "I prefer concise answers.", "I get anxious before exams."],
    )

    from backend.models.memory import MemoryCompactionRequest
    req = MemoryCompactionRequest(
        request_id="comp_1",
        user_id_hash="user_hash_123",
        interactions=interactions,
        force=True,
    )

    result = service.compact_local(req)
    assert result.summary.preferred_name == "Alex"
    assert "exams" in result.summary.known_triggers
