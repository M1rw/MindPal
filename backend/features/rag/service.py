# backend/features/rag/service.py

"""
Hybrid RAG retrieval and grounding coordinator for MindPal.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from backend.core.config import Settings, get_settings
from backend.core.security import normalize_locale, sanitize_text
from .clinical_extractor import extract_clinical_concepts
from .corpus_loader import load_corpus
from .schemas import GroundingUnit, RAGPlan, RagReference, ScoredGroundingUnit

logger = logging.getLogger(__name__)

MAX_QUERY_CHARS = 2_000
DEFAULT_MAX_RESULTS = 4


class RAGService:
    """Clinical and wellness grounding retrieval engine."""

    def __init__(
        self,
        *,
        corpus: list[GroundingUnit] | None = None,
        corpus_dir: Path | None = None,
        settings: Settings | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self._corpus: list[GroundingUnit] = corpus if corpus is not None else load_corpus(corpus_dir)

    @property
    def corpus_size(self) -> int:
        return len(self._corpus)

    def health(self) -> dict[str, Any]:
        return {
            "status": "ok" if self._corpus else "degraded",
            "corpus_size": len(self._corpus),
            "configured": True,
        }

    async def retrieve(
        self,
        query: str,
        *,
        locale: str = "auto",
        max_results: int = DEFAULT_MAX_RESULTS,
    ) -> list[dict[str, Any]]:
        clean_query = sanitize_text(query, MAX_QUERY_CHARS).strip().lower()
        if not clean_query:
            return []

        scored: list[ScoredGroundingUnit] = []
        q_words = set(clean_query.split())

        for unit in self._corpus:
            matched_terms = [t for t in unit.trigger_terms if t.lower() in clean_query]
            tag_overlap = [t for t in unit.tags if t.lower() in q_words]
            if matched_terms or tag_overlap:
                score = (len(matched_terms) * 2.0 + len(tag_overlap) * 1.0) * unit.confidence_weight
                scored.append(ScoredGroundingUnit(unit=unit, score=score, matched_terms=tuple(matched_terms)))

        scored.sort(key=lambda s: s.score, reverse=True)
        results = []
        for item in scored[:max_results]:
            u = item.unit
            results.append({
                "grounding_id": u.grounding_id,
                "category": u.category,
                "technique": u.technique,
                "instructions": list(u.instructions),
                "contraindications": list(u.contraindications),
                "response_style": list(u.response_style),
                "source": u.source,
                "score": round(item.score, 3),
            })
        return results
