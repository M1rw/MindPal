# backend/features/memory/service.py

"""
Memory service orchestrating graph storage, search, compaction, and prompt assembly.
"""

from __future__ import annotations

import logging
from typing import Any

from backend.core.config import Settings, get_settings
from backend.core.security import sanitize_text
from .graph_service import build_memory_prompt_from_graph
from .repo import MemoryRepository
from .schemas import MemoryAtom, MemoryCategory, MemoryGraph, MemoryStatus

logger = logging.getLogger(__name__)


class MemoryService:
    """Personalized episodic and semantic memory management service."""

    def __init__(
        self,
        *,
        repository: MemoryRepository | None = None,
        settings: Settings | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.repo = repository or MemoryRepository()

    async def load_graph(self, user_id_hash: str) -> MemoryGraph:
        return await self.repo.load(user_id_hash)

    async def save_graph(self, user_id_hash: str, graph: MemoryGraph) -> None:
        await self.repo.save(user_id_hash, graph)

    async def search(
        self,
        *,
        user_id: str,
        query: str,
        category: str | None = None,
        limit: int = 5,
    ) -> list[dict[str, Any]]:
        graph = await self.load_graph(user_id)
        q_clean = sanitize_text(query, 200).lower()
        cat_clean = sanitize_text(category or "", 50).lower()

        results = []
        for atom in graph.active_atoms():
            if cat_clean and atom.category.value.lower() != cat_clean:
                continue
            text = f"{atom.title} {atom.value}".lower()
            if q_clean in text or any(q in text for q in q_clean.split()):
                results.append({
                    "id": atom.id,
                    "category": atom.category.value,
                    "title": atom.title,
                    "value": atom.value,
                    "confidence": atom.confidence,
                    "pinned": atom.pinned,
                })
                if len(results) >= limit:
                    break

        return results

    async def get_prompt_context(self, user_id_hash: str) -> str:
        graph = await self.load_graph(user_id_hash)
        return build_memory_prompt_from_graph(graph)
