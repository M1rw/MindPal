# backend/services/domain/memory/compaction.py

from __future__ import annotations

from dataclasses import dataclass
from backend.models.memory import MemoryCompactionResult


@dataclass(frozen=True, slots=True)
class MemoryCompactionMeta:
    mode: str
    used_llm: bool
    fallback_used: bool
    provider_used: str | None = None
    error_code: str | None = None


@dataclass(frozen=True, slots=True)
class LLMCompactionOutcome:
    result: MemoryCompactionResult
    provider_used: str
