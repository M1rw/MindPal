# backend/features/brain/service.py

"""
Deterministic graph operations and bounded context planning for MindPal Brain.
"""

from __future__ import annotations

import math
import re
from typing import Any

from backend.models.memory import (
    BrainEdge,
    BrainEdgeType,
    BrainEvidence,
    MemoryAtom,
    MemoryCategory,
    MemoryGraph,
    MemorySensitivity,
    MemoryStatus,
    normalize_memory_value,
)
from .schemas import (
    MAX_BRAIN_MAP_DEPTH,
    MAX_CONTEXT_EDGES,
    MAX_CONTEXT_EVIDENCE,
    MAX_CONTEXT_NODES,
    BrainContextPack,
    BrainEdgeView,
    BrainEvidenceView,
    BrainMapView,
    BrainNodeType,
    BrainNodeView,
    BrainPolicyTier,
)

_TOKEN_RE = re.compile(r"[^\w]+", flags=re.UNICODE)
_CATEGORY_NODE_TYPES: dict[MemoryCategory, BrainNodeType] = {
    MemoryCategory.PEOPLE: BrainNodeType.PERSON,
    MemoryCategory.GOALS: BrainNodeType.GOAL,
    MemoryCategory.PROJECTS: BrainNodeType.GOAL,
    MemoryCategory.PATTERNS: BrainNodeType.PATTERN,
    MemoryCategory.COPING_TOOLS: BrainNodeType.COPING_TOOL,
    MemoryCategory.PREFERENCES: BrainNodeType.PREFERENCE,
    MemoryCategory.AVOID: BrainNodeType.BOUNDARY,
    MemoryCategory.SAFETY_CONTEXT: BrainNodeType.SAFETY_CONTEXT,
    MemoryCategory.PROFILE: BrainNodeType.CONTEXT,
    MemoryCategory.RELATIONSHIP_CONTEXT: BrainNodeType.CONTEXT,
    MemoryCategory.FACTS: BrainNodeType.CONTEXT,
}


class BrainService:
    """Projects Memory V3 atoms into an interconnected cognitive graph."""

    def __init__(self, memory_service: Any = None) -> None:
        self.memory = memory_service

    def build_map(
        self,
        graph: MemoryGraph,
        *,
        focus_atom_id: str | None = None,
        depth: int = 1,
        tier: BrainPolicyTier = BrainPolicyTier.STANDARD,
    ) -> BrainMapView:
        nodes = []
        for atom in graph.active_atoms():
            if _is_tier_permitted(atom.sensitivity, tier):
                nodes.append(_project_node(atom))

        edges = []
        for edge in graph.active_edges():
            edges.append(_project_edge(edge))

        return BrainMapView(
            graph_version=graph.version,
            scope="local" if focus_atom_id else "global",
            focus_atom_id=focus_atom_id,
            depth=min(depth, MAX_BRAIN_MAP_DEPTH),
            nodes=nodes,
            edges=edges,
        )

    def plan_context(
        self,
        graph: MemoryGraph,
        query: str,
        *,
        tier: BrainPolicyTier = BrainPolicyTier.STANDARD,
    ) -> BrainContextPack:
        q_tokens = _tokens(query)
        scored = []
        for atom in graph.active_atoms():
            if not _is_tier_permitted(atom.sensitivity, tier):
                continue
            a_tokens = _tokens(f"{atom.title} {atom.value}")
            overlap = len(q_tokens & a_tokens)
            score = (overlap / max(1, len(q_tokens))) + (0.2 if atom.pinned else 0.0)
            scored.append((score, atom))

        scored.sort(key=lambda x: x[0], reverse=True)
        top_atoms = [atom for score, atom in scored[:MAX_CONTEXT_NODES] if score > 0]
        nodes = [_project_node(a) for a in top_atoms]
        focus = nodes[0] if nodes else None
        related = nodes[1:] if len(nodes) > 1 else []

        rendered = render_context_pack_for_prompt(nodes)
        return BrainContextPack(
            focus_node=focus,
            related_nodes=related,
            edges=[],
            evidence=[],
            rendered_context=rendered,
        )


def render_context_pack_for_prompt(nodes: list[BrainNodeView]) -> str:
    if not nodes:
        return ""
    lines = ["Relevant personal context from long-term memory graph:"]
    for node in nodes:
        lines.append(f"- [{node.node_type.value.upper()}] {node.title}: {node.summary}")
    return "\n".join(lines)


def _project_node(atom: MemoryAtom) -> BrainNodeView:
    node_type = _CATEGORY_NODE_TYPES.get(atom.category, BrainNodeType.CONTEXT)
    return BrainNodeView(
        id=atom.id,
        node_type=node_type,
        category=atom.category,
        title=atom.title or atom.value[:40],
        summary=atom.value,
        confidence=atom.confidence,
        sensitivity=atom.sensitivity,
        source=atom.source_message_id or "system",
        pinned=atom.pinned,
        evidence_count=len(atom.evidence_atoms),
        aliases=list(atom.tags),
        created_at=atom.created_at,
        updated_at=atom.updated_at,
        last_confirmed_at=atom.last_confirmed_at,
        hidden_from_replies=atom.sensitivity == MemorySensitivity.RESTRICTED,
    )


def _project_edge(edge: BrainEdge) -> BrainEdgeView:
    return BrainEdgeView(
        id=edge.id,
        source_atom_id=edge.source_atom_id,
        target_atom_id=edge.target_atom_id,
        relation=edge.relation,
        confidence=edge.confidence,
        tentative=edge.tentative,
        created_at=edge.created_at,
        last_confirmed_at=edge.last_confirmed_at,
    )


def _is_tier_permitted(sensitivity: MemorySensitivity, tier: BrainPolicyTier) -> bool:
    if tier == BrainPolicyTier.RESTRICTED:
        return True
    if tier == BrainPolicyTier.SENSITIVE:
        return sensitivity != MemorySensitivity.RESTRICTED
    return sensitivity == MemorySensitivity.STANDARD


def _tokens(value: str) -> set[str]:
    normalized = normalize_memory_value(value)
    return {part for part in _TOKEN_RE.split(normalized) if len(part) > 1}
