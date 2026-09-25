"""Person-initiated memory edits and the summary view, shared by the HTTP layer.

Every edit keeps what the server knows (reinforcement history, the AI summary)
and makes sure a fact the person removed does not survive anywhere MindPal
reads from: the generated summary, the AI summary, or conversation digests.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from backend.domain.memory.consolidation import MemoryConsolidationService
from backend.domain.memory.graph import (
    MAX_ATOMS,
    MemoryAtom,
    MemoryGraph,
    MemoryGraphService,
    atom_from_mapping,
    clip_atom_value,
    honest_summary,
    rank_atoms,
    summary_from_atoms,
)


class MemoryEditor:
    def __init__(self, memory: MemoryGraphService, consolidation: MemoryConsolidationService) -> None:
        self.memory = memory
        self.consolidation = consolidation

    def replace(self, user_id_hash: str, raw_atoms: Optional[List[Dict[str, Any]]], summary: Optional[str]) -> MemoryGraph:
        """Whole-graph replace from the memory inspector (PUT).

        A fact whose text changed under the same id is a correction, and the old
        text is forgotten exactly like a deleted fact (audit MP-14): only removed
        ids used to count, so "Lives in Paris" corrected to "Lives in Cairo"
        stayed in the AI summary and digests. A summary the person writes
        replaces the AI one, which used to keep showing over it.
        """
        outdated: List[str] = []

        def change(existing: MemoryGraph) -> None:
            atoms = existing.atoms if raw_atoms is None else self._clean_atoms(raw_atoms, existing)
            new_values = {atom.id: atom.value for atom in atoms}
            outdated[:] = [a.value for a in existing.atoms if new_values.get(a.id) != a.value]
            if summary is not None:
                existing.summary, existing.summary_auto = honest_summary(summary), False
                existing.narrative, existing.narrative_at, existing.open_threads = "", 0.0, []
            elif existing.summary_auto or not existing.summary:
                existing.summary = summary_from_atoms(rank_atoms(atoms)) if atoms else ""
                existing.summary_auto = True
            existing.atoms = atoms

        graph, _ = self.memory.mutate_graph(user_id_hash, change)
        return self._forget_removed(user_id_hash, outdated, graph)

    def edit_atom(self, user_id_hash: str, atom_id: str, value: str) -> Optional[MemoryGraph]:
        """Correct one fact (PATCH). The old wording is forgotten everywhere derived."""
        before = {atom.id: atom.value for atom in self.memory.get_memory_graph(user_id_hash).atoms}
        graph = self.memory.update_atom(user_id_hash, atom_id, value)
        if graph is None:
            return None
        old = before.get(str(atom_id or "").strip())
        updated = next((a.value for a in graph.atoms if a.id == str(atom_id or "").strip()), None)
        if old and updated is not None and old != updated:
            return self._forget_removed(user_id_hash, [old], graph)
        return graph

    def delete_atom(self, user_id_hash: str, atom_id: str) -> MemoryGraph:
        removed: List[str] = []

        def change(graph: MemoryGraph) -> None:
            removed[:] = [a.value for a in graph.atoms if a.id == atom_id]
            graph.atoms = [a for a in graph.atoms if a.id != atom_id]
            if graph.summary_auto or not graph.summary:
                graph.summary = summary_from_atoms(rank_atoms(graph.atoms)) if graph.atoms else ""
                graph.summary_auto = True

        graph, _ = self.memory.mutate_graph(user_id_hash, change)
        return self._forget_removed(user_id_hash, removed, graph)

    def summary_view(self, user_id_hash: str) -> Dict[str, Any]:
        graph = self.memory.get_memory_graph(user_id_hash)
        if not graph.narrative and not graph.summary and graph.atoms:
            graph = self.memory.rebuild_summary(user_id_hash)
        return summary_payload(user_id_hash, graph)

    def refresh_summary(self, user_id_hash: str) -> Dict[str, Any]:
        """Rewrite the AI summary now if budget and load allow; otherwise queue it."""
        self.consolidation.request_summary(user_id_hash)
        report = self.consolidation.run(user_id_hash, force=True)
        if report.summarized:
            status = "updated"
        elif report.skipped in {"load_critical", "daily_budget"}:
            status = "queued"
        else:
            status = "unchanged"
        return {**self.summary_view(user_id_hash), "status": status, "reason": report.skipped or None}

    # -- helpers ------------------------------------------------------------

    @staticmethod
    def _clean_atoms(raw_atoms: List[Dict[str, Any]], existing: MemoryGraph) -> List[MemoryAtom]:
        known = {atom.id: atom for atom in existing.atoms}
        seen: set[str] = set()
        atoms: List[MemoryAtom] = []
        for raw in raw_atoms:
            atom = atom_from_mapping(raw)
            if atom is None or atom.id in seen:
                continue
            atom.value = clip_atom_value(atom.value)
            if not atom.value:
                continue
            previous = known.get(atom.id)
            if previous is not None:
                # The client does not send reinforcement history; keep the server's.
                atom.mentions, atom.first_seen, atom.last_seen = previous.mentions, previous.first_seen, previous.last_seen
            seen.add(atom.id)
            atoms.append(atom)
            if len(atoms) >= MAX_ATOMS:
                break
        return atoms

    def _forget_removed(self, user_id_hash: str, removed: List[str], graph: MemoryGraph) -> MemoryGraph:
        # A deleted or rewritten fact leaves the meaning index now, not at the next refresh.
        from backend.domain.memory.vectors import MemoryVectors

        try:
            MemoryVectors(self.memory.store).sync(user_id_hash, graph.atoms)
        except Exception:  # the index is derived; memory edits never fail because of it
            pass
        if not removed:
            return graph
        self.consolidation.forget_facts(user_id_hash, removed)
        return self.memory.get_memory_graph(user_id_hash)


def summary_payload(user_id_hash: str, graph: MemoryGraph) -> Dict[str, Any]:
    """The best summary available, labelled with where it came from."""
    if graph.narrative:
        summary, source = graph.narrative, "ai"
    elif graph.summary and not graph.summary_auto:
        summary, source = graph.summary, "user"
    else:
        summary, source = graph.summary, "facts"
    return {
        "user_id_hash": user_id_hash,
        "summary": summary,
        "source": source,
        "updated_at": graph.narrative_at if source == "ai" else None,
        "open_threads": list(graph.open_threads) if source == "ai" else [],
    }
