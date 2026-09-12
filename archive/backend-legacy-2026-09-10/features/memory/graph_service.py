# backend/features/memory/graph_service.py

"""
Graph-level memory mutations, entity extraction, tombstones, and prompt assembly.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any

from backend.core.security import sanitize_text
from .schemas import (
    CATEGORY_TIER,
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

_NAME_PATTERNS = (
    re.compile(r"(?i)\b(?:my name is|call me|i am called|i'm called)\s+([^.,!?\n]{2,80})"),
    re.compile(r"(?:اسمي|ناديني|اسمي هو)\s+([^.,!?\n،؟]{2,80})"),
)


def delete_memory_atom(graph: MemoryGraph, atom_id: str) -> MemoryGraph:
    next_graph = graph.model_copy(deep=True)
    if atom_id in next_graph.atoms:
        atom = next_graph.atoms[atom_id]
        next_graph.atoms[atom_id] = atom.model_copy(
            update={"status": MemoryStatus.DELETED, "updated_at": datetime.now(UTC)}
        )
    return next_graph


def upsert_memory_atom(graph: MemoryGraph, atom: MemoryAtom) -> MemoryGraph:
    next_graph = graph.model_copy(deep=True)
    next_graph.atoms[atom.id] = atom.model_copy(update={"updated_at": datetime.now(UTC)})
    return next_graph


def merge_memory_graph(existing: MemoryGraph, incoming: MemoryGraph | list[MemoryAtom]) -> MemoryGraph:
    merged = existing.model_copy(deep=True)
    atoms = incoming.atoms.values() if isinstance(incoming, MemoryGraph) else incoming
    for atom in atoms:
        merged = upsert_memory_atom(merged, atom)
    merged.version = existing.version + 1
    merged.updated_at = datetime.now(UTC)
    return merged


def build_memory_prompt_from_graph(graph: MemoryGraph, *, max_chars: int = 2500) -> str:
    active = graph.active_atoms()
    if not active:
        return ""

    lines = []
    for atom in active:
        tier = CATEGORY_TIER.get(atom.category, MemoryTier.KNOWLEDGE)
        if tier != MemoryTier.ARCHIVE:
            lines.append(f"- [{atom.category.value}] {atom.value}")

    joined = "\n".join(lines)
    return sanitize_text(joined, max_chars)
