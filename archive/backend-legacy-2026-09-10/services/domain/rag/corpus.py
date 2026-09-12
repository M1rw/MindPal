# backend/services/domain/rag/corpus.py

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from backend.models.chat import RagReference


@dataclass(frozen=True, slots=True)
class PreparedSearchTerm:
    """Tokenized search query term for fast lexical matching."""

    term: str
    term_lower: str
    term_tokens: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class GroundingUnit:
    """Individual evidence unit in the RAG corpus with clinical grounding instructions."""

    grounding_id: str
    category: str
    technique: str
    trigger_terms: tuple[str, ...]
    instructions: tuple[str, ...]
    contraindications: tuple[str, ...]
    response_style: tuple[str, ...]
    tags: tuple[str, ...]
    source: str = "curated"

    def to_prompt_dict(self, *, score: float | None = None) -> dict[str, Any]:
        """Format grounding unit as a prompt context dictionary."""
        payload: dict[str, Any] = {
            "grounding_id": self.grounding_id,
            "category": self.category,
            "technique": self.technique,
            "trigger_terms": list(self.trigger_terms),
            "instructions": list(self.instructions),
            "contraindications": list(self.contraindications),
            "response_style": list(self.response_style),
            "source": self.source,
        }

        if score is not None:
            payload["score"] = round(max(0.0, min(float(score), 1.0)), 4)

        return payload

    def to_reference(self, *, score: float) -> RagReference:
        """Convert grounding unit to RagReference model."""
        return RagReference(
            grounding_id=self.grounding_id,
            category=self.category,
            technique=self.technique,
            score=score,
        )


@dataclass(frozen=True, slots=True)
class RetrievalMatch:
    """Scored match result pairing a GroundingUnit with relevance score."""

    unit: GroundingUnit
    score: float
    matched_terms: tuple[str, ...]

    def to_prompt_dict(self) -> dict[str, Any]:
        """Convert retrieval match to prompt dictionary."""
        payload = self.unit.to_prompt_dict(score=self.score)
        payload["matched_terms"] = list(self.matched_terms)
        return payload

    def to_reference(self) -> RagReference:
        """Convert match to RagReference."""
        return self.unit.to_reference(score=self.score)
