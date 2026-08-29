# backend/features/memory/repo.py

"""
Transactional memory repository for Memory Graph persistence and version conflict handling.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from backend.core.errors import AppError
from .schemas import MemoryGraph

MAX_MEMORY_DOCUMENT_BYTES = 700_000


class MemoryVersionConflictError(AppError):
    status_code = 409
    code = "memory_version_conflict"


@dataclass(frozen=True, slots=True)
class MemoryMergeResult:
    snapshot: MemoryGraph
    changed: bool


class MemoryRepository:
    """Canonical transactional repository for Memory Graph V3."""

    def __init__(self, *, db: Any = None) -> None:
        self.db = db
        self._in_memory_graphs: dict[str, MemoryGraph] = {}

    async def load(self, user_id_hash: str) -> MemoryGraph:
        if self.db is not None and hasattr(self.db, "load_memory_graph"):
            graph_load = await self.db.load_memory_graph(user_id_hash)
            if graph_load.loaded and graph_load.graph:
                return graph_load.graph
        return self._in_memory_graphs.get(user_id_hash, MemoryGraph(version=1))

    async def save(self, user_id_hash: str, graph: MemoryGraph) -> None:
        updated = graph.model_copy(update={"version": graph.version + 1, "updated_at": datetime.now(UTC)})
        self._in_memory_graphs[user_id_hash] = updated
        if self.db is not None and hasattr(self.db, "save_memory_graph"):
            await self.db.save_memory_graph(user_id_hash, updated)


def _fit_graph_document(graph: MemoryGraph) -> MemoryGraph:
    return graph
