from __future__ import annotations

from backend.models.brain import BrainPolicyTier
from backend.models.memory import (
    BrainEdge,
    BrainEdgeStatus,
    BrainEdgeType,
    BrainEvidence,
    BrainWorkspace,
    MemoryCategory,
    MemoryGraph,
    MemorySensitivity,
    MemorySource,
    make_memory_atom,
)
from backend.services.brain_service import BrainService, render_context_pack_for_prompt
from backend.services.memory_graph_service import delete_memory_atom


def _graph() -> MemoryGraph:
    user_hash = "brain-test-user"
    goal = make_memory_atom(
        user_id_hash=user_hash,
        category=MemoryCategory.GOALS,
        value="Keep a consistent sleep routine during deadline weeks",
        confidence=0.92,
        source=MemorySource.MANUAL,
        pinned=True,
    )
    pattern = make_memory_atom(
        user_id_hash=user_hash,
        category=MemoryCategory.PATTERNS,
        value="Deadline pressure can affect sleep and energy",
        confidence=0.83,
        source=MemorySource.CHAT_EXTRACTION,
    )
    tool = make_memory_atom(
        user_id_hash=user_hash,
        category=MemoryCategory.COPING_TOOLS,
        value="A short evening walk helps me transition from work",
        confidence=0.76,
        source=MemorySource.MANUAL,
    )
    hidden = make_memory_atom(
        user_id_hash=user_hash,
        category=MemoryCategory.SAFETY_CONTEXT,
        value="Restricted context not suitable for a standard map",
        confidence=0.95,
        source=MemorySource.MANUAL,
        sensitivity=MemorySensitivity.HIGH,
    )
    edge = BrainEdge(
        id="edge_pattern_goal",
        source_atom_id=pattern.id,
        target_atom_id=goal.id,
        relation=BrainEdgeType.AFFECTS,
        confidence=0.86,
    )
    evidence = BrainEvidence(
        id="evidence_goal",
        atom_id=goal.id,
        excerpt="I want my bedtime to be more consistent before deadlines.",
        source=MemorySource.MANUAL,
    )
    return MemoryGraph(
        user_id_hash=user_hash,
        atoms=[goal, pattern, tool, hidden],
        brain=BrainWorkspace(edges=[edge], evidence=[evidence]),
    )


def test_standard_policy_hides_restricted_nodes_and_context_is_bounded() -> None:
    graph = _graph()
    service = BrainService()

    visible = service.map_view(graph, policy_tier=BrainPolicyTier.STANDARD)
    visible_ids = {node.id for node in visible.nodes}
    restricted = next(atom for atom in graph.atoms if atom.category == MemoryCategory.SAFETY_CONTEXT)
    assert restricted.id not in visible_ids
    assert len(visible.edges) == 1

    plan = service.plan_context(
        graph,
        "How do I protect my sleep routine while deadlines are stressful?",
        intent="goal_planning",
        policy_tier=BrainPolicyTier.STANDARD,
    )
    assert len(plan.nodes) <= 6
    assert len(plan.evidence) <= 2
    assert len(plan.edges) <= 8
    assert restricted.id not in {node.id for node in plan.nodes}
    assert any("sleep" in node.text.lower() for node in plan.nodes)
    rendered = render_context_pack_for_prompt(plan)
    assert "RELEVANT_USER_BRAIN_CONTEXT_BEGIN" in rendered
    assert "RELEVANT_USER_BRAIN_CONTEXT_END" in rendered
    assert "Restricted context" not in rendered


def test_context_cache_and_local_map_are_graph_version_safe() -> None:
    graph = _graph()
    service = BrainService()
    goal = next(atom for atom in graph.atoms if atom.category == MemoryCategory.GOALS)

    first = service.plan_context(graph, "sleep deadline", policy_tier=BrainPolicyTier.STANDARD)
    second = service.plan_context(graph, "sleep deadline", policy_tier=BrainPolicyTier.STANDARD)
    assert first.cache_hit is False
    assert second.cache_hit is True

    local = service.map_view(graph, focus_atom_id=goal.id, depth=1)
    assert local.scope == "local"
    assert goal.id in {node.id for node in local.nodes}
    assert len(local.nodes) == 2


def test_atom_deletion_detaches_evidence_and_tombstones_links() -> None:
    graph = _graph()
    goal = next(atom for atom in graph.atoms if atom.category == MemoryCategory.GOALS)
    updated = delete_memory_atom(graph, goal.id)

    assert not any(item.atom_id == goal.id for item in updated.brain.evidence)
    assert all(
        edge.status == BrainEdgeStatus.DELETED
        for edge in updated.brain.edges
        if goal.id in {edge.source_atom_id, edge.target_atom_id}
    )
    visible = BrainService().map_view(updated)
    assert goal.id not in {node.id for node in visible.nodes}
