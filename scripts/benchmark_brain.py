"""Deterministic before/after benchmark for MindPal Memory V3 and Brain planning.

This is a synthetic *test workload*, not a claim about live user outcomes. It uses
only generic wellness/productivity fixtures and produces a reproducible comparison
between the legacy broad tier-two selection and the bounded Brain context planner.
"""

from __future__ import annotations

import json
from pathlib import Path
from statistics import median
from time import perf_counter

from backend.models.brain import BrainPolicyTier
from backend.models.memory import (
    BrainEdge,
    BrainEdgeType,
    BrainEvidence,
    BrainWorkspace,
    MemoryCategory,
    MemoryGraph,
    MemorySensitivity,
    MemorySource,
    make_memory_atom,
    build_memory_prompt_from_graph,
)
from backend.services.domain.memory import BrainService, render_context_pack_for_prompt


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_PATH = ROOT / "docs/benchmarks/mindpal-brain-benchmark.json"
ITERATIONS = 200


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * percentile)))
    return ordered[index]


def _fixture_graph() -> tuple[MemoryGraph, set[str], str]:
    user_hash = "benchmark-user"
    generic_categories = [
        MemoryCategory.PROJECTS,
        MemoryCategory.PREFERENCES,
        MemoryCategory.FACTS,
        MemoryCategory.RELATIONSHIP_CONTEXT,
        MemoryCategory.COPING_TOOLS,
        MemoryCategory.PATTERNS,
    ]
    atoms = []
    for index in range(297):
        category = generic_categories[index % len(generic_categories)]
        atoms.append(
            make_memory_atom(
                user_id_hash=user_hash,
                category=category,
                value=f"General context record {index + 1}: routine observation about life area {index % 17}",
                confidence=0.42 + ((index % 23) / 100),
                source=MemorySource.CHAT_EXTRACTION,
                sensitivity=MemorySensitivity.LOW,
                aliases=[f"area {index % 17}"],
            )
        )

    goal = make_memory_atom(
        user_id_hash=user_hash,
        category=MemoryCategory.GOALS,
        value="Maintain a consistent sleep routine before demanding work deadlines",
        display_value="Protect sleep during deadline weeks",
        confidence=0.94,
        source=MemorySource.MANUAL,
        sensitivity=MemorySensitivity.MEDIUM,
        pinned=True,
        aliases=["sleep plan", "deadline routine"],
    )
    pattern = make_memory_atom(
        user_id_hash=user_hash,
        category=MemoryCategory.PATTERNS,
        value="Deadline pressure can affect sleep quality and next-day energy",
        confidence=0.89,
        source=MemorySource.CHAT_EXTRACTION,
        sensitivity=MemorySensitivity.MEDIUM,
        aliases=["work stress", "sleep pressure"],
    )
    tool = make_memory_atom(
        user_id_hash=user_hash,
        category=MemoryCategory.COPING_TOOLS,
        value="A short evening walk helps transition away from work before bed",
        confidence=0.84,
        source=MemorySource.MANUAL,
        sensitivity=MemorySensitivity.LOW,
        aliases=["evening walk", "wind down"],
    )
    atoms.extend([goal, pattern, tool])
    graph = MemoryGraph(
        user_id_hash=user_hash,
        atoms=atoms,
        brain=BrainWorkspace(
            edges=[
                BrainEdge(
                    id="edge_benchmark_pattern_goal",
                    source_atom_id=pattern.id,
                    target_atom_id=goal.id,
                    relation=BrainEdgeType.AFFECTS,
                    confidence=0.89,
                ),
                BrainEdge(
                    id="edge_benchmark_tool_goal",
                    source_atom_id=tool.id,
                    target_atom_id=goal.id,
                    relation=BrainEdgeType.HELPS_WITH,
                    confidence=0.84,
                ),
            ],
            evidence=[
                BrainEvidence(
                    id="evidence_benchmark_sleep",
                    atom_id=goal.id,
                    excerpt="I want to keep my bedtime consistent when work gets intense.",
                    source=MemorySource.MANUAL,
                    sensitivity=MemorySensitivity.MEDIUM,
                )
            ],
        ),
    )
    query = "How can I protect my sleep routine when work deadlines are making me stressed?"
    return graph, {goal.id, pattern.id, tool.id}, query


def _legacy_selection(graph: MemoryGraph) -> tuple[list[str], str]:
    selected = [*graph.tier1_atoms(), *graph.tier2_atoms(max_items=30)]
    unique = {atom.id: atom for atom in selected}
    ordered = list(unique.values())
    legacy_graph = graph.model_copy(update={"atoms": ordered})
    return [atom.id for atom in ordered], build_memory_prompt_from_graph(legacy_graph)


def _measure_latency(fn) -> dict[str, float]:
    samples = []
    for _ in range(ITERATIONS):
        started = perf_counter()
        fn()
        samples.append((perf_counter() - started) * 1_000)
    return {"p50_ms": round(median(samples), 4), "p95_ms": round(_percentile(samples, 0.95), 4)}


def main() -> None:
    graph, relevant_ids, query = _fixture_graph()
    legacy_ids, legacy_prompt = _legacy_selection(graph)
    planner = BrainService()
    first_plan = planner.plan_context(graph, query, intent="goal_planning", policy_tier=BrainPolicyTier.STANDARD)
    brain_ids = [node.id for node in first_plan.nodes]
    brain_prompt = render_context_pack_for_prompt(first_plan)

    legacy_matches = len(relevant_ids.intersection(legacy_ids))
    brain_matches = len(relevant_ids.intersection(brain_ids))
    result = {
        "workload": {
            "fixture": "deterministic generic wellness/productivity test graph",
            "atom_count": len(graph.atoms),
            "query": query,
            "relevant_node_count": len(relevant_ids),
            "iterations": ITERATIONS,
        },
        "before_memory_v3_broad_selection": {
            "selected_nodes": len(legacy_ids),
            "relevant_nodes_selected": legacy_matches,
            "relevance_density": round(legacy_matches / max(1, len(legacy_ids)), 4),
            "prompt_characters": len(legacy_prompt),
            "latency": _measure_latency(lambda: _legacy_selection(graph)),
        },
        "after_brain_context_planner": {
            "selected_nodes": len(brain_ids),
            "relevant_nodes_selected": brain_matches,
            "relevance_density": round(brain_matches / max(1, len(brain_ids)), 4),
            "prompt_characters": len(brain_prompt),
            "evidence_items": len(first_plan.evidence),
            "edge_items": len(first_plan.edges),
            "cache_hit_after_warmup": planner.plan_context(graph, query, intent="goal_planning").cache_hit,
            "latency": _measure_latency(lambda: BrainService().plan_context(graph, query, intent="goal_planning")),
        },
    }
    result["improvement"] = {
        "context_node_reduction_percent": round((1 - result["after_brain_context_planner"]["selected_nodes"] / max(1, result["before_memory_v3_broad_selection"]["selected_nodes"])) * 100, 2),
        "prompt_character_reduction_percent": round((1 - result["after_brain_context_planner"]["prompt_characters"] / max(1, result["before_memory_v3_broad_selection"]["prompt_characters"])) * 100, 2),
        "relevance_density_multiplier": round(result["after_brain_context_planner"]["relevance_density"] / max(.0001, result["before_memory_v3_broad_selection"]["relevance_density"]), 2),
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
