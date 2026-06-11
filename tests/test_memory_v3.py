from __future__ import annotations

from backend.models.memory import (
    CommunicationPreferences,
    ImportantPerson,
    MemorySummary,
)
from backend.models.memory_v3 import (
    MemoryCategory,
    MemoryGraph,
    MemorySource,
    make_memory_atom,
    memory_graph_from_summary,
    summary_from_memory_graph,
)
from backend.services.memory_graph_service import (
    build_memory_graph_prompt,
    delete_memory_atom,
    extract_memory_graph_from_text,
    merge_memory_graph,
)


def test_creates_graph_from_explicit_memory_text() -> None:
    graph = extract_memory_graph_from_text(
        "remember: avoid apologetic responses",
        user_id_hash="user-a",
    )

    assert graph.atoms
    assert graph.atoms[0].category == MemoryCategory.AVOID
    assert graph.atoms[0].source == MemorySource.MANUAL
    assert graph.atoms[0].confidence >= 0.95


def test_migrates_memory_summary_to_memory_graph() -> None:
    summary = MemorySummary(
        user_id_hash="user-a",
        preferred_name="Marwan",
        important_people=[
            ImportantPerson(
                canonical_name="Mi",
                aliases=["Mi", "Maya"],
                relationship="girlfriend",
            )
        ],
        communication_preferences=CommunicationPreferences(
            response_style=["direct answers"],
            avoid=["apologetic responses"],
        ),
    )

    graph = memory_graph_from_summary(summary)

    assert any(atom.category == MemoryCategory.PROFILE for atom in graph.atoms)
    assert any(atom.category == MemoryCategory.PEOPLE and "Maya" in atom.aliases for atom in graph.atoms)
    assert any(atom.category == MemoryCategory.AVOID for atom in graph.atoms)


def test_merges_avoid_items_into_one_category_and_dedupes_semantic_values() -> None:
    first = extract_memory_graph_from_text("remember: avoid apologetic responses", user_id_hash="user-a")
    second = extract_memory_graph_from_text("remember: avoid apologetic", user_id_hash="user-a")
    merged = merge_memory_graph(first, second)

    avoid_atoms = [atom for atom in merged.atoms if atom.category == MemoryCategory.AVOID and atom.status == "active"]

    assert len(avoid_atoms) == 1
    assert avoid_atoms[0].evidence_count >= 2


def test_partial_delta_preserves_existing_memory() -> None:
    existing = extract_memory_graph_from_text("my name is Marwan", user_id_hash="user-a")
    delta = extract_memory_graph_from_text("my project is MindPal", user_id_hash="user-a")
    merged = merge_memory_graph(existing, delta)

    assert any(atom.category == MemoryCategory.PROFILE for atom in merged.atoms)
    assert any(atom.category == MemoryCategory.PROJECTS for atom in merged.atoms)


def test_deletion_tombstone_prevents_non_manual_recreation() -> None:
    graph = extract_memory_graph_from_text("remember: avoid apologetic responses", user_id_hash="user-a")
    atom_id = graph.atoms[0].id
    deleted = delete_memory_atom(graph, atom_id, tombstone=True)
    incoming = MemoryGraph(
        user_id_hash="user-a",
        atoms=[
            make_memory_atom(
                user_id_hash="user-a",
                category=MemoryCategory.AVOID,
                value="apologetic responses",
                source=MemorySource.BACKEND_COMPACTION,
                confidence=0.7,
            )
        ],
    )

    merged = merge_memory_graph(deleted, incoming)

    assert [atom.status for atom in merged.atoms if atom.id == atom_id] == ["deleted"]


def test_pinned_manual_memory_wins_over_lower_confidence_llm_memory() -> None:
    manual = MemoryGraph(
        user_id_hash="user-a",
        atoms=[
            make_memory_atom(
                user_id_hash="user-a",
                category=MemoryCategory.PREFERENCES,
                value="direct answers",
                source=MemorySource.MANUAL,
                confidence=0.95,
                pinned=True,
            )
        ],
    )
    llm = MemoryGraph(
        user_id_hash="user-a",
        atoms=[
            make_memory_atom(
                user_id_hash="user-a",
                category=MemoryCategory.PREFERENCES,
                value="direct answers",
                display_value="gentle direct answers",
                source=MemorySource.BACKEND_COMPACTION,
                confidence=0.6,
            )
        ],
    )

    merged = merge_memory_graph(manual, llm)

    assert merged.atoms[0].display_value == "direct answers"
    assert merged.atoms[0].pinned is True


def test_prompt_context_is_concise_and_grouped() -> None:
    graph = merge_memory_graph(
        extract_memory_graph_from_text("my name is Marwan", user_id_hash="user-a"),
        extract_memory_graph_from_text("remember: avoid emotional responses", user_id_hash="user-a"),
    )

    prompt = build_memory_graph_prompt(graph)

    assert "Saved user memory:" in prompt
    assert "Profile:" in prompt
    assert "Avoid:" in prompt
    assert len(prompt) < 2_000


def test_memory_graph_to_summary_compatibility() -> None:
    graph = merge_memory_graph(
        extract_memory_graph_from_text("my name is Marwan", user_id_hash="user-a"),
        extract_memory_graph_from_text("I prefer direct answers", user_id_hash="user-a"),
    )

    summary = summary_from_memory_graph(graph)

    assert summary.preferred_name == "Marwan"
    assert "direct answers" in summary.communication_preferences.response_style
