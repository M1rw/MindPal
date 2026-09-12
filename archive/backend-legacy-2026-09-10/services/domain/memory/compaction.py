# backend/services/domain/memory/compaction.py

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from backend.models.memory import MemoryCompactionResult


class CompactionMode(StrEnum):
    """Execution modes for memory compaction processing."""

    LOCAL = "local"
    LLM = "llm"
    HYBRID = "hybrid"


@dataclass(frozen=True, slots=True)
class MemoryCompactionMeta:
    """Metadata tracking execution status and provider usage for memory compaction operations."""

    mode: str
    used_llm: bool
    fallback_used: bool
    provider_used: str | None = None
    error_code: str | None = None


@dataclass(frozen=True, slots=True)
class LLMCompactionOutcome:
    """Successful outcome container for LLM-driven memory compaction."""

    result: MemoryCompactionResult
    provider_used: str
