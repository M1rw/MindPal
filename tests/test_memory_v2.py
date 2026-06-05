from __future__ import annotations

from backend.models.memory import (
    CommunicationPreferences,
    ImportantPerson,
    MemorySummary,
)
from backend.services.memory_service import MemoryService


def test_memory_v2_extracts_structured_identity_people_and_preferences() -> None:
    service = MemoryService(enable_llm_summarization=False)

    extraction = service.extract(
        "My name is Marwan. My girlfriend is named Maya. "
        "I may write her name as Mi or Maya. "
        "I prefer direct answers and concise practical guidance. "
        "Do not answer like random identity questions."
    )

    assert extraction.preferred_name == "Marwan"
    assert extraction.important_people

    girlfriend = extraction.important_people[0]
    assert girlfriend.canonical_name == "Maya"
    assert girlfriend.relationship == "girlfriend"
    assert set(girlfriend.aliases) >= {"Maya", "Mi"}

    assert extraction.communication_preferences.tone == "direct"
    assert "direct answers" in extraction.communication_preferences.response_style
    assert "random identity questions" in extraction.avoided_responses


def test_memory_v2_merges_aliases_preferences_and_relationship_facts() -> None:
    service = MemoryService(enable_llm_summarization=False)
    existing = MemorySummary(
        user_id_hash="user-a",
        important_people=[
            ImportantPerson(
                canonical_name="Maya",
                aliases=["Maya"],
                relationship="girlfriend",
                confidence=0.7,
            )
        ],
        communication_preferences=CommunicationPreferences(
            tone="",
            language="",
            response_style=["short answers"],
            avoid=[],
        ),
    )

    extraction = service.extract(
        "My girlfriend is named Mi. Trust and overthinking are a relationship issue. "
        "Please be direct answers. Do not answer like formal MSA."
    )
    merged = service.merge_summary(existing, extraction, user_id_hash="user-a")

    assert len(merged.important_people) == 1
    assert set(merged.important_people[0].aliases) >= {"Maya", "Mi"}
    assert merged.communication_preferences.tone == "direct"
    assert set(merged.communication_preferences.response_style) >= {
        "short answers",
        "direct answers",
    }
    assert "formal MSA" in " ".join(merged.avoided_responses)
    assert any("relationship" in fact.summary.lower() for fact in merged.relationship_facts)


def test_memory_v2_prompt_summary_includes_structured_memory() -> None:
    service = MemoryService(enable_llm_summarization=False)
    summary = MemorySummary(
        user_id_hash="user-a",
        preferred_name="Marwan",
        important_people=[
            ImportantPerson(
                canonical_name="Maya",
                aliases=["Maya", "Mi"],
                relationship="girlfriend",
            )
        ],
        communication_preferences=CommunicationPreferences(
            tone="direct",
            language="Egyptian Arabic when the user writes Egyptian Arabic",
            response_style=["concise practical guidance"],
            avoid=["random identity questions"],
        ),
        avoided_responses=["formal MSA when user writes dialect"],
    )

    prompt_summary = service.build_prompt_summary(summary)

    assert "Preferred name: Marwan" in prompt_summary
    assert "Maya (girlfriend); aliases: Mi" in prompt_summary
    assert "tone=direct" in prompt_summary
    assert "random identity questions" in prompt_summary
    assert "formal MSA when user writes dialect" in prompt_summary
