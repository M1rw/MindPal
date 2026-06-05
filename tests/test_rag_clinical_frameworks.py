from __future__ import annotations

from backend.core.prompts import VALID_RAG_TAGS
from backend.services.rag_service import RAGService


def _rag() -> RAGService:
    return RAGService(enable_llm_planning=False)


def _ids_for(query: str, *, max_results: int = 6) -> list[str]:
    return [match.unit.grounding_id for match in _rag().retrieve(query, max_results=max_results)]


def test_panic_message_retrieves_panic_grounding() -> None:
    matches = _rag().retrieve("I am having a panic attack and cannot breathe", max_results=3)

    assert matches
    assert matches[0].unit.grounding_id == "clinical_panic_grounding_54321"
    assert "panic_grounding" in matches[0].unit.tags
    assert "grounding_54321" in matches[0].unit.tags


def test_anger_message_retrieves_dbt_stop() -> None:
    ids = _ids_for("I am furious and about to explode, I might send something bad")

    assert "clinical_dbt_stop_anger_delay" in ids


def test_overthinking_retrieves_cognitive_reframe() -> None:
    matches = _rag().retrieve("I am overthinking everything and catastrophizing", max_results=3)

    assert matches
    assert matches[0].unit.grounding_id == "clinical_cognitive_reframe_overthinking"
    assert "cognitive_reframe" in matches[0].unit.tags


def test_arabic_relationship_distress_retrieves_boundary_and_safety() -> None:
    boundary_ids = _ids_for("مش عارفة اكمل العلاقة هو بيقلل مني وبيتحكم فيا")
    safety_ids = _ids_for("خايفة منه وبيهددني ومش سايبني اخرج")

    assert "clinical_relationship_boundary" in boundary_ids
    assert "clinical_relationship_safety" in safety_ids


def test_rag_health_reports_units_tags_and_failed_files() -> None:
    health = _rag().health()
    clinical_units = [
        unit
        for unit in _rag().units
        if unit.source == "mindpal_clinical_frameworks.yaml"
    ]

    assert health["units_loaded"] >= 8
    assert isinstance(health["tags"], list)
    assert isinstance(health["failed_files"], list)
    assert "clinical_frameworks" in " ".join(health["loaded_files"])
    assert clinical_units

    valid_tags = set(VALID_RAG_TAGS)
    for unit in clinical_units:
        assert set(unit.tags).issubset(valid_tags)
