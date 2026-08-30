# tests/unit/domain/test_rag_domain.py

import pytest
from backend.services.domain.rag import RAGService


def test_rag_service_retrieval():
    service = RAGService()
    matches = service.retrieve("I am having a panic attack and can't breathe", max_results=3)

    assert len(matches) > 0
    top_match = matches[0]
    assert top_match.score > 0
    assert top_match.unit.grounding_id in ["grounding_54321", "box_breathing_basic"]


@pytest.mark.asyncio
async def test_rag_service_contextual_retrieval():
    service = RAGService()
    result = await service.retrieve_contextual("I feel anxious", safety_tags=["anxiety"])

    assert len(result.matches) > 0
    assert result.plan.locale in ["en", "auto"]
