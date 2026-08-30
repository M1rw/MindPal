# backend/services/domain/rag/planner.py

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any
from backend.models.chat import RagReference


@dataclass(frozen=True, slots=True)
class RAGQueryPlan:
    rewritten_query: str
    tags: tuple[str, ...]
    categories: tuple[str, ...]
    techniques: tuple[str, ...]
    contraindications: tuple[str, ...]
    locale: str
    source: str

    def combined_terms(self) -> tuple[str, ...]:
        seen: set[str] = set()
        output: list[str] = []
        for term in list(self.tags) + list(self.categories) + list(self.techniques) + list(self.contraindications):
            key = term.strip().lower()
            if key and key not in seen:
                seen.add(key)
                output.append(term)
        return tuple(output)


@dataclass(frozen=True, slots=True)
class RAGRetrievalResult:
    matches: tuple[Any, ...]
    prompt_grounding: tuple[dict[str, Any], ...]
    references: tuple[RagReference, ...]
    plan: RAGQueryPlan
    used_llm_plan: bool
    fallback_used: bool
    planner_provider: str | None = None
    error_code: str | None = None

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "references": [reference.model_dump(mode="json") for reference in self.references],
            "plan": asdict(self.plan),
            "used_llm_plan": self.used_llm_plan,
            "fallback_used": self.fallback_used,
            "planner_provider": self.planner_provider,
            "error_code": self.error_code,
        }
