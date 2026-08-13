from __future__ import annotations

from dataclasses import dataclass
import json
from datetime import datetime, timezone
from collections.abc import Callable
from typing import Any

from backend.core.errors import AppError
from backend.models.memory import (
    BrainWorkspace,
    MemoryCategory,
    MemoryGraph,
    MemoryGraphPatch,
    MemoryStatus,
    memory_graph_from_summary,
)
from backend.services.db_service import DBService
from backend.services.memory_graph_service import delete_memory_atom, merge_memory_graph


class MemoryVersionConflictError(AppError):
    status_code = 409
    code = "memory_version_conflict"


@dataclass(frozen=True, slots=True)
class MemoryMergeResult:
    snapshot: MemoryGraph
    changed: bool


MAX_MEMORY_DOCUMENT_BYTES = 700_000


class MemoryRepository:
    """Canonical transactional repository for Memory Graph V3.

    Memory Graph V3 is the only writable source of truth. Legacy summaries are
    read once for migration and are thereafter derived from the graph.
    """

    def __init__(self, *, db: DBService) -> None:
        self.db = db

    async def load(self, user_id_hash: str) -> MemoryGraph:
        graph_load = await self.db.load_memory_graph(user_id_hash)
        if graph_load.loaded and graph_load.graph:
            return graph_load.graph
        legacy = await self.db.load_memory(user_id_hash)
        migrated = memory_graph_from_summary(legacy.summary) if legacy.summary else MemoryGraph(user_id_hash=user_id_hash)
        return await self.initialize_if_missing(migrated.model_copy(update={"user_id_hash": user_id_hash}))

    async def initialize_if_missing(self, graph: MemoryGraph) -> MemoryGraph:
        now = datetime.now(timezone.utc)

        def updater(data: dict[str, Any]) -> dict[str, Any]:
            if data:
                return data
            initialized = graph.model_copy(
                update={
                    "version": max(1, graph.version),
                    "full_snapshot": True,
                    "created_at": graph.created_at or now,
                    "updated_at": now,
                }
            )
            return _fit_graph_document(initialized).model_dump(mode="json")

        data = await self.db.provider.atomic_update_document(
            self.db.MEMORY_GRAPH_COLLECTION,
            graph.user_id_hash,
            updater,
        )
        return MemoryGraph.model_validate(data)

    async def replace(
        self,
        *,
        user_id_hash: str,
        graph: MemoryGraph,
        expected_version: int | None = None,
    ) -> MemoryMergeResult:
        changed = False

        def updater(data: dict[str, Any]) -> dict[str, Any]:
            nonlocal changed
            existing = MemoryGraph.model_validate(data) if data else None
            if existing is not None and expected_version is not None and expected_version != existing.version:
                raise MemoryVersionConflictError(
                    "Memory changed on another device",
                    details={"expected_version": expected_version, "current_version": existing.version},
                )
            # Older clients do not yet send a Brain envelope. Preserve the server
            # envelope in that case rather than treating an omitted field as a reset.
            incoming_brain = graph.brain if _brain_has_content(graph.brain) or existing is None else existing.brain
            incoming = _fit_graph_document(
                graph.model_copy(
                    update={
                        "user_id_hash": user_id_hash,
                        "full_snapshot": True,
                        "brain": incoming_brain,
                        "created_at": existing.created_at if existing else graph.created_at,
                        "updated_at": datetime.now(timezone.utc),
                    }
                )
            )
            before_content = _persistent_content(existing) if existing else None
            after_content = _persistent_content(incoming)
            changed = before_content != after_content
            if not changed and existing is not None:
                return existing.model_dump(mode="json")
            incoming = incoming.model_copy(update={"version": (existing.version + 1) if existing else 1})
            return incoming.model_dump(mode="json")

        data = await self.db.provider.atomic_update_document(self.db.MEMORY_GRAPH_COLLECTION, user_id_hash, updater)
        return MemoryMergeResult(MemoryGraph.model_validate(data), changed)

    async def merge(self, *, user_id_hash: str, delta: MemoryGraph | list[Any]) -> MemoryMergeResult:
        return await self._mutate(user_id_hash=user_id_hash, atoms_or_graph=delta, deleted_atom_ids=[])

    async def patch(self, *, user_id_hash: str, patch: MemoryGraphPatch) -> MemoryMergeResult:
        return await self._mutate(
            user_id_hash=user_id_hash,
            atoms_or_graph=patch.atoms,
            deleted_atom_ids=patch.deleted_atom_ids,
        )

    async def delete_atom(self, *, user_id_hash: str, atom_id: str) -> MemoryMergeResult:
        return await self._mutate(user_id_hash=user_id_hash, atoms_or_graph=[], deleted_atom_ids=[atom_id])

    async def delete_all(self, *, user_id_hash: str) -> None:
        await self.db.provider.delete_document(self.db.MEMORY_GRAPH_COLLECTION, user_id_hash)
        # Remove the retired cache too so a later load cannot remigrate stale data.
        await self.db.delete_memory(user_id_hash)

    async def update_brain(
        self,
        *,
        user_id_hash: str,
        mutate: Callable[[MemoryGraph], MemoryGraph],
        expected_version: int | None = None,
    ) -> MemoryMergeResult:
        """Atomically apply a validated Brain mutation without rewriting atom data."""
        changed = False

        def updater(data: dict[str, Any]) -> dict[str, Any]:
            nonlocal changed
            existing = MemoryGraph.model_validate(data) if data else MemoryGraph(user_id_hash=user_id_hash)
            if expected_version is not None and expected_version != existing.version:
                raise MemoryVersionConflictError(
                    "Memory changed on another device",
                    details={"expected_version": expected_version, "current_version": existing.version},
                )
            candidate = _fit_graph_document(mutate(existing).model_copy(update={"user_id_hash": user_id_hash}))
            changed = _persistent_content(existing) != _persistent_content(candidate)
            if not changed:
                return existing.model_dump(mode="json")
            candidate = candidate.model_copy(
                update={
                    "version": existing.version + 1,
                    "full_snapshot": True,
                    "created_at": existing.created_at,
                    "updated_at": datetime.now(timezone.utc),
                }
            )
            return candidate.model_dump(mode="json")

        data = await self.db.provider.atomic_update_document(self.db.MEMORY_GRAPH_COLLECTION, user_id_hash, updater)
        return MemoryMergeResult(MemoryGraph.model_validate(data), changed)

    async def _mutate(
        self,
        *,
        user_id_hash: str,
        atoms_or_graph: MemoryGraph | list[Any],
        deleted_atom_ids: list[str],
    ) -> MemoryMergeResult:
        changed = False

        def updater(data: dict[str, Any]) -> dict[str, Any]:
            nonlocal changed
            existing = MemoryGraph.model_validate(data) if data else MemoryGraph(user_id_hash=user_id_hash)
            candidate = existing
            for atom_id in deleted_atom_ids:
                candidate = delete_memory_atom(candidate, atom_id, tombstone=True)
            candidate = merge_memory_graph(candidate, atoms_or_graph)
            candidate = _fit_graph_document(candidate)
            changed = _persistent_content(existing) != _persistent_content(candidate)
            if not changed:
                return existing.model_dump(mode="json")
            candidate = candidate.model_copy(
                update={
                    "user_id_hash": user_id_hash,
                    "version": existing.version + 1,
                    "full_snapshot": True,
                    "created_at": existing.created_at,
                    "updated_at": datetime.now(timezone.utc),
                }
            )
            return candidate.model_dump(mode="json")

        data = await self.db.provider.atomic_update_document(self.db.MEMORY_GRAPH_COLLECTION, user_id_hash, updater)
        return MemoryMergeResult(MemoryGraph.model_validate(data), changed)


def _persistent_content(graph: MemoryGraph) -> dict[str, Any]:
    """Return user-controlled data that determines whether a graph version must advance."""
    payload = graph.model_dump(mode="json")
    return {"atoms": payload.get("atoms", []), "brain": payload.get("brain", {})}


def _brain_has_content(brain: BrainWorkspace) -> bool:
    return bool(brain.edges or brain.evidence or brain.review_queue or brain.collections)


def _fit_brain_workspace(brain: BrainWorkspace, max_bytes: int) -> BrainWorkspace:
    """Keep Brain records bounded before atom fitting; newest user controls survive first."""
    candidate = brain
    for _ in range(8):
        encoded = json.dumps(candidate.model_dump(mode="json"), ensure_ascii=False, separators=(",", ":"), default=str)
        if len(encoded.encode("utf-8")) <= max_bytes:
            return candidate
        candidate = candidate.model_copy(
            update={
                "collections": candidate.collections[: max(0, len(candidate.collections) // 2)],
                "review_queue": candidate.review_queue[: max(0, len(candidate.review_queue) // 2)],
                "evidence": candidate.evidence[: max(0, len(candidate.evidence) // 2)],
                "edges": candidate.edges[: max(0, len(candidate.edges) // 2)],
            }
        )
    return candidate.model_copy(update={"edges": [], "evidence": [], "review_queue": [], "collections": []})


def _fit_graph_document(graph: MemoryGraph) -> MemoryGraph:
    """Bound a graph below Firestore's document limit without dropping core facts first."""
    bounded_brain = _fit_brain_workspace(graph.brain, MAX_MEMORY_DOCUMENT_BYTES // 2)
    graph = graph.model_copy(update={"brain": bounded_brain})
    payload = graph.model_copy(update={"atoms": []}).model_dump(mode="json")
    used = len(json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8"))
    identity_categories = {
        MemoryCategory.PROFILE,
        MemoryCategory.PEOPLE,
        MemoryCategory.SAFETY_CONTEXT,
    }

    ranked = sorted(
        graph.atoms,
        key=lambda atom: (
            0 if atom.pinned else 1,
            0 if atom.status == MemoryStatus.ACTIVE else 1 if atom.status == MemoryStatus.ARCHIVED else 2,
            0 if atom.category in identity_categories else 1,
            -float(atom.confidence),
            -atom.updated_at.timestamp(),
        ),
    )
    kept = []
    for atom in ranked:
        atom_payload = atom.model_dump(mode="json")
        atom_size = len(
            json.dumps(atom_payload, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8")
        ) + 16
        if used + atom_size > MAX_MEMORY_DOCUMENT_BYTES:
            continue
        kept.append(atom)
        used += atom_size

    # Restore stable category/time ordering for deterministic clients and diffs.
    kept.sort(key=lambda atom: (atom.category.value, atom.created_at, atom.id))
    return graph.model_copy(update={"atoms": kept})
