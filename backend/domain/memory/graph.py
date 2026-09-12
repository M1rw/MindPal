# backend/domain/memory/graph.py — Memory Graph Domain

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Any, Optional
from backend.infra.store.store import get_store


@dataclass
class MemoryAtom:
    id: str
    category: str
    value: str
    confidence: float = 1.0


@dataclass
class MemoryGraph:
    user_id_hash: str
    summary: str = "User is building a therapeutic reflective space."
    atoms: List[MemoryAtom] = field(default_factory=list)


class MemoryGraphService:
    """Manages User Memory Graph and Narrative Synthesizer."""

    def __init__(self) -> None:
        self.store = get_store()

    def get_memory_graph(self, user_id_hash: str) -> MemoryGraph:
        doc = self.store.get_document("memory_graphs", user_id_hash)
        if not doc:
            return MemoryGraph(user_id_hash=user_id_hash)

        atoms = [MemoryAtom(**a) for a in doc.get("atoms", [])]
        return MemoryGraph(
            user_id_hash=user_id_hash,
            summary=doc.get("summary", "User is building a therapeutic reflective space."),
            atoms=atoms,
        )

    def save_memory_graph(self, graph: MemoryGraph) -> None:
        doc = {
            "user_id_hash": graph.user_id_hash,
            "summary": graph.summary,
            "atoms": [{"id": a.id, "category": a.category, "value": a.value, "confidence": a.confidence} for a in graph.atoms],
        }
        self.store.set_document("memory_graphs", graph.user_id_hash, doc)

    def update_summary(self, user_id_hash: str, new_summary: str) -> MemoryGraph:
        graph = self.get_memory_graph(user_id_hash)
        graph.summary = new_summary
        self.save_memory_graph(graph)
        return graph
