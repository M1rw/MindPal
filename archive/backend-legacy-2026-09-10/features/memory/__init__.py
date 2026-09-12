# backend/features/memory/__init__.py

"""
Memory feature public exports gatekeeper.
"""

from .graph_service import (
    build_memory_prompt_from_graph,
    delete_memory_atom,
    merge_memory_graph,
    upsert_memory_atom,
)
from .repo import (
    MAX_MEMORY_DOCUMENT_BYTES,
    MemoryMergeResult,
    MemoryRepository,
    MemoryVersionConflictError,
)
from .routes import router
from .schemas import (
    CATEGORY_TIER,
    MAX_ATOMS,
    MAX_ATOM_SHORT_CHARS,
    MAX_ATOM_TEXT_CHARS,
    MAX_MEMORY_SUMMARY_CHARS,
    BrainEdge,
    BrainEdgeStatus,
    BrainEdgeType,
    BrainEvidence,
    BrainReviewKind,
    BrainReviewRecord,
    BrainReviewStatus,
    MemoryAtom,
    MemoryCategory,
    MemoryGraph,
    MemorySensitivity,
    MemorySource,
    MemoryStatus,
    MemoryTier,
    make_memory_atom,
    normalize_memory_value,
)
from .service import MemoryService

__all__ = [
    "BrainEdge",
    "BrainEdgeStatus",
    "BrainEdgeType",
    "BrainEvidence",
    "BrainReviewKind",
    "BrainReviewRecord",
    "BrainReviewStatus",
    "CATEGORY_TIER",
    "MAX_ATOMS",
    "MAX_ATOM_SHORT_CHARS",
    "MAX_ATOM_TEXT_CHARS",
    "MAX_MEMORY_DOCUMENT_BYTES",
    "MAX_MEMORY_SUMMARY_CHARS",
    "MemoryAtom",
    "MemoryCategory",
    "MemoryGraph",
    "MemoryMergeResult",
    "MemoryRepository",
    "MemorySensitivity",
    "MemoryService",
    "MemorySource",
    "MemoryStatus",
    "MemoryTier",
    "MemoryVersionConflictError",
    "build_memory_prompt_from_graph",
    "delete_memory_atom",
    "make_memory_atom",
    "merge_memory_graph",
    "normalize_memory_value",
    "router",
    "upsert_memory_atom",
]
