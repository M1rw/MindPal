# backend/services/domain/memory/extraction.py

from __future__ import annotations

from dataclasses import dataclass
from backend.models.memory import (
    CommunicationPreferences,
    ImportantPerson,
    MemoryItem,
    RelationshipFact,
)


@dataclass(frozen=True, slots=True)
class MemoryExtraction:
    """Structured extraction output containing psychological, relational, and factual user memory items."""

    summary_sentences: tuple[str, ...]
    preferred_name: str | None
    important_people: tuple[ImportantPerson, ...]
    relationship_facts: tuple[RelationshipFact, ...]
    communication_preferences: CommunicationPreferences
    emotional_triggers: tuple[str, ...]
    user_goals: tuple[str, ...]
    avoided_responses: tuple[str, ...]
    triggers: tuple[str, ...]
    coping_tools: tuple[str, ...]
    goals: tuple[str, ...]
    preferences: tuple[str, ...]
    safety_flags: tuple[str, ...]
    items: tuple[MemoryItem, ...]
