# backend/services/memory_service.py

"""
Memory Service re-export module for backward compatibility.
Implementation moved to backend.services.domain.memory.
"""

from __future__ import annotations

from backend.services.domain.memory import (
    LLMCompactionOutcome,
    MemoryCompactionMeta,
    MemoryExtraction,
    MemoryService,
    build_memory_interactions,
)

__all__ = [
    "LLMCompactionOutcome",
    "MemoryCompactionMeta",
    "MemoryExtraction",
    "MemoryService",
    "build_memory_interactions",
]
