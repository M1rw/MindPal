# backend/features/rag/schemas.py

"""
RAG grounding unit schemas and retrieval contracts.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


@dataclass(frozen=True, slots=True)
class GroundingUnit:
    grounding_id: str
    category: str
    technique: str
    trigger_terms: tuple[str, ...]
    instructions: tuple[str, ...]
    contraindications: tuple[str, ...]
    response_style: tuple[str, ...]
    source: str
    tags: tuple[str, ...] = ()
    confidence_weight: float = 1.0


@dataclass(frozen=True, slots=True)
class RAGPlan:
    rewritten_query: str = ""
    tags: list[str] = field(default_factory=list)
    categories: list[str] = field(default_factory=list)
    techniques: list[str] = field(default_factory=list)
    contraindications: list[str] = field(default_factory=list)
    locale: str = "auto"


@dataclass(frozen=True, slots=True)
class ScoredGroundingUnit:
    unit: GroundingUnit
    score: float
    matched_terms: tuple[str, ...] = ()


class RagReference(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    source: str = Field(min_length=1, max_length=120)
    category: str = Field(min_length=1, max_length=80)
    technique: str = Field(min_length=1, max_length=120)
    confidence: float = Field(default=0.8, ge=0.0, le=1.0)
