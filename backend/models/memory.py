# backend/models/memory.py
#
# Unified MindPal Memory Model — Adaptive Cortical Memory (ACM)
#
# This module defines all memory types for MindPal's tiered memory system:
#
#   Tier 1 — Identity Core (always injected into prompt)
#       PROFILE, PEOPLE, SAFETY_CONTEXT
#
#   Tier 2 — Durable Knowledge (filtered by relevance)
#       PREFERENCES, AVOID, PATTERNS, GOALS, PROJECTS,
#       RELATIONSHIP_CONTEXT, COPING_TOOLS, FACTS
#
#   Tier 3 — Archive (never injected, used for tombstones and history)
#       Deleted/archived atoms
#
# Architecture:
#   - MemoryAtom: individual memory fact (the universal unit)
#   - MemoryGraph: collection of atoms per user (the primary storage format)
#   - MemorySummary: legacy flat format (kept for backward compat, auto-migrated)
#
# This file merges the former memory.py (v1/v2) and memory_v3.py (graph) into
# a single source of truth. No more clashing enums or aliased imports.

from __future__ import annotations

import hashlib
import math
import re
from datetime import datetime
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from backend.core.security import (
    Locale,
    normalize_locale,
    sanitize_text,
)
from backend.models._helpers import (
    sanitize_metadata,
    sanitize_pii_text,
    sanitize_string_list as _sanitize_string_list_helper,
    utcnow,
)
from backend.models.safety import SafetyLevel


# ═══════════════════════════════════════════════════════════════
# Constants
# ═══════════════════════════════════════════════════════════════

MAX_ATOMS = 500
MAX_ATOM_TEXT_CHARS = 700
MAX_ATOM_SHORT_CHARS = 180
MAX_ALIASES = 30

MAX_MEMORY_SUMMARY_CHARS = 4_000
MAX_MEMORY_ITEM_TEXT_CHARS = 700
MAX_MEMORY_LIST_ITEM_CHARS = 180
MAX_MEMORY_LIST_ITEMS = 80
MAX_MEMORY_INTERACTION_CHARS = 2_000
MAX_MEMORY_INTERACTIONS = 50
MAX_METADATA_ITEMS = 40
MAX_METADATA_VALUE_CHARS = 300
MAX_MEMORY_ALIAS_ITEMS = 20
MAX_MEMORY_SHORT_TEXT_CHARS = 160

# Confidence decay: 2% per week (0.02 / 7 days)
CONFIDENCE_DECAY_PER_DAY = 0.02 / 7.0
# Minimum confidence before an atom is considered stale
MIN_RELEVANCE_CONFIDENCE = 0.15
# Emotional categories get a 1.5x relevance boost
EMOTIONAL_RELEVANCE_BOOST = 1.5


# ═══════════════════════════════════════════════════════════════
# Enums — unified (no more clashing names between files)
# ═══════════════════════════════════════════════════════════════

class MemoryCategory(str, Enum):
    """Graph-based memory categories (the primary taxonomy)."""
    PROFILE = "profile"
    PEOPLE = "people"
    PROJECTS = "projects"
    PREFERENCES = "preferences"
    AVOID = "avoid"
    PATTERNS = "patterns"
    GOALS = "goals"
    RELATIONSHIP_CONTEXT = "relationship_context"
    COPING_TOOLS = "coping_tools"
    SAFETY_CONTEXT = "safety_context"
    FACTS = "facts"


class MemoryTier(str, Enum):
    """Which tier this category belongs to for prompt injection."""
    IDENTITY = "identity"       # Always in prompt
    KNOWLEDGE = "knowledge"     # Filtered by relevance
    ARCHIVE = "archive"         # Never injected


# Map each category to its tier
CATEGORY_TIER: dict[MemoryCategory, MemoryTier] = {
    MemoryCategory.PROFILE: MemoryTier.IDENTITY,
    MemoryCategory.PEOPLE: MemoryTier.IDENTITY,
    MemoryCategory.SAFETY_CONTEXT: MemoryTier.IDENTITY,
    MemoryCategory.PREFERENCES: MemoryTier.KNOWLEDGE,
    MemoryCategory.AVOID: MemoryTier.KNOWLEDGE,
    MemoryCategory.PATTERNS: MemoryTier.KNOWLEDGE,
    MemoryCategory.GOALS: MemoryTier.KNOWLEDGE,
    MemoryCategory.PROJECTS: MemoryTier.KNOWLEDGE,
    MemoryCategory.RELATIONSHIP_CONTEXT: MemoryTier.KNOWLEDGE,
    MemoryCategory.COPING_TOOLS: MemoryTier.KNOWLEDGE,
    MemoryCategory.FACTS: MemoryTier.KNOWLEDGE,
}

# Categories that get emotional relevance boost
EMOTIONAL_CATEGORIES: frozenset[MemoryCategory] = frozenset({
    MemoryCategory.SAFETY_CONTEXT,
    MemoryCategory.PATTERNS,
    MemoryCategory.COPING_TOOLS,
})


class LegacyMemoryCategory(str, Enum):
    """Legacy v1/v2 memory item categories (for backward compat)."""
    TRIGGER = "trigger"
    COPING_TOOL = "coping_tool"
    GOAL = "goal"
    PREFERENCE = "preference"
    SAFETY_FLAG = "safety_flag"
    LIFE_EVENT = "life_event"
    SUPPORT_CONTEXT = "support_context"
    OTHER = "other"


class MemorySource(str, Enum):
    """Where a memory came from (unified — covers both legacy and graph)."""
    MANUAL = "manual"
    CHAT_EXTRACTION = "chat_extraction"
    BACKEND_COMPACTION = "backend_compaction"
    PROFILE = "profile"
    IMPORT = "import"
    # Legacy aliases — kept for backward compat with stored data
    CHAT_COMPACTION = "chat_compaction"
    USER_PROFILE = "user_profile"
    SAFETY_EVENT = "safety_event"
    UNKNOWN = "unknown"


class MemorySensitivity(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class MemoryStatus(str, Enum):
    ACTIVE = "active"
    ARCHIVED = "archived"
    DELETED = "deleted"


class MemoryInteractionRole(str, Enum):
    USER = "user"
    ASSISTANT = "assistant"


_utcnow = utcnow
_sanitize_memory_text = sanitize_pii_text


# ═══════════════════════════════════════════════════════════════
# Core Graph Types (primary storage format)
# ═══════════════════════════════════════════════════════════════

class MemoryAtom(BaseModel):
    """
    A single atomic memory fact — the universal unit of MindPal memory.

    Each atom is:
    - categorized by domain (profile, people, patterns, etc.)
    - confidence-scored (0.0-1.0, decays over time)
    - sensitivity-tagged (controls PII handling)
    - tombstone-capable (deleted atoms block re-creation)
    - relevance-scored for prompt injection prioritization
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    id: str = Field(min_length=1, max_length=160)
    category: MemoryCategory
    key: str = Field(min_length=1, max_length=220)
    value: str = Field(min_length=1, max_length=MAX_ATOM_TEXT_CHARS)
    normalized_value: str = Field(min_length=1, max_length=MAX_ATOM_TEXT_CHARS)
    display_value: str = Field(min_length=1, max_length=MAX_ATOM_TEXT_CHARS)
    confidence: float = Field(default=0.6, ge=0.0, le=1.0)
    sensitivity: MemorySensitivity = MemorySensitivity.MEDIUM
    source: MemorySource = MemorySource.CHAT_EXTRACTION
    status: MemoryStatus = MemoryStatus.ACTIVE
    pinned: bool = False
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
    last_seen_at: datetime = Field(default_factory=utcnow)
    evidence_count: int = Field(default=1, ge=0, le=10_000)
    aliases: list[str] = Field(default_factory=list, max_length=MAX_ALIASES)
    vector: list[float] | None = Field(default=None)
    metadata: dict[str, str | int | float | bool | None] = Field(default_factory=dict)

    @field_validator("id", "key", "value", "normalized_value", "display_value", mode="before")
    @classmethod
    def _clean_text(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), MAX_ATOM_TEXT_CHARS)
        if not cleaned:
            raise ValueError("memory atom text cannot be empty")
        return cleaned

    @field_validator("aliases", mode="before")
    @classmethod
    def _clean_aliases(cls, value: object) -> list[str]:
        return _clean_graph_string_list(value, max_items=MAX_ALIASES)

    @field_validator("metadata", mode="before")
    @classmethod
    def _clean_metadata(cls, value: object) -> dict[str, str | int | float | bool | None]:
        if not isinstance(value, dict):
            return {}

        cleaned: dict[str, str | int | float | bool | None] = {}
        for raw_key, raw_value in list(value.items())[:MAX_METADATA_ITEMS]:
            key = sanitize_text(str(raw_key or ""), MAX_ATOM_SHORT_CHARS)
            if not key:
                continue
            if raw_value is None or isinstance(raw_value, bool | int | float):
                cleaned[key] = raw_value
            else:
                cleaned[key] = sanitize_text(str(raw_value), MAX_ATOM_TEXT_CHARS)
        return cleaned

    @model_validator(mode="after")
    def _normalize_identity(self) -> MemoryAtom:
        if not self.normalized_value:
            self.normalized_value = normalize_memory_value(self.value)
        if not self.display_value:
            self.display_value = self.value
        return self

    @property
    def tier(self) -> MemoryTier:
        """Which prompt-injection tier this atom belongs to."""
        if self.status != MemoryStatus.ACTIVE:
            return MemoryTier.ARCHIVE
        return CATEGORY_TIER.get(self.category, MemoryTier.KNOWLEDGE)

    def relevance_score(self, *, now: datetime | None = None) -> float:
        """
        Compute relevance score for prompt injection prioritization.

        Formula: confidence × recency_weight × evidence_factor × emotional_boost

        - recency_weight: exponential decay based on days since last seen
        - evidence_factor: log-scaled boost for repeatedly reinforced facts
        - emotional_boost: 1.5x for safety/pattern/coping categories
        """
        if self.status != MemoryStatus.ACTIVE:
            return 0.0

        reference = now or utcnow()
        days_since_seen = max(0.0, (reference - self.last_seen_at).total_seconds() / 86400.0)

        # Exponential recency decay (half-life ~30 days)
        recency_weight = math.exp(-0.023 * days_since_seen)

        # Log-scaled evidence factor (1.0 at count=1, ~1.3 at count=10, ~1.6 at count=100)
        evidence_factor = 1.0 + 0.15 * math.log(max(1, self.evidence_count))

        # Emotional boost
        emotional_boost = EMOTIONAL_RELEVANCE_BOOST if self.category in EMOTIONAL_CATEGORIES else 1.0

        # Pinned items get maximum weight
        pin_boost = 1.5 if self.pinned else 1.0

        return self.confidence * recency_weight * evidence_factor * emotional_boost * pin_boost

    def decayed_confidence(self, *, now: datetime | None = None) -> float:
        """
        Compute confidence after time-based decay.

        Pinned atoms and identity-tier atoms don't decay.
        Returns the decayed confidence (does NOT mutate the atom).
        """
        if self.pinned or self.tier == MemoryTier.IDENTITY:
            return self.confidence

        reference = now or utcnow()
        days_since_update = max(0.0, (reference - self.updated_at).total_seconds() / 86400.0)
        decay = CONFIDENCE_DECAY_PER_DAY * days_since_update
        return max(MIN_RELEVANCE_CONFIDENCE, self.confidence - decay)


class MemoryGraph(BaseModel):
    """
    The primary memory storage format — a collection of MemoryAtoms per user.
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    user_id_hash: str = Field(min_length=1, max_length=120)
    atoms: list[MemoryAtom] = Field(default_factory=list, max_length=MAX_ATOMS)
    version: int = Field(default=1, ge=1)
    source: MemorySource = MemorySource.BACKEND_COMPACTION
    full_snapshot: bool = True
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    @field_validator("user_id_hash", mode="before")
    @classmethod
    def _clean_user_hash(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), 120)
        if not cleaned:
            raise ValueError("user_id_hash cannot be empty")
        return cleaned

    @model_validator(mode="after")
    def _dedupe_atom_ids(self) -> MemoryGraph:
        seen: set[str] = set()
        output: list[MemoryAtom] = []
        for atom in self.atoms:
            if atom.id in seen:
                continue
            seen.add(atom.id)
            output.append(atom)
        self.atoms = output[:MAX_ATOMS]
        return self

    @property
    def active_atoms(self) -> list[MemoryAtom]:
        """Return only active (non-deleted, non-archived) atoms."""
        return [atom for atom in self.atoms if atom.status == MemoryStatus.ACTIVE]

    def tier1_atoms(self) -> list[MemoryAtom]:
        """Return identity-tier atoms (always injected into prompt)."""
        return [atom for atom in self.active_atoms if atom.tier == MemoryTier.IDENTITY]

    def tier2_atoms(self, *, max_items: int = 30, now: datetime | None = None) -> list[MemoryAtom]:
        """Return knowledge-tier atoms sorted by relevance score."""
        candidates = [atom for atom in self.active_atoms if atom.tier == MemoryTier.KNOWLEDGE]
        candidates.sort(key=lambda a: a.relevance_score(now=now), reverse=True)
        return candidates[:max_items]


class MemoryGraphPatch(BaseModel):
    """Delta patch for updating a memory graph."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    atoms: list[MemoryAtom] = Field(default_factory=list, max_length=MAX_ATOMS)
    deleted_atom_ids: list[str] = Field(default_factory=list, max_length=MAX_ATOMS)
    full_snapshot: bool = False

    @field_validator("deleted_atom_ids", mode="before")
    @classmethod
    def _clean_ids(cls, value: object) -> list[str]:
        return _clean_graph_string_list(value, max_items=MAX_ATOMS)


class MemoryGraphLoadResult(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    user_id_hash: str
    loaded: bool = False
    graph: MemoryGraph | None = None
    migrated_from_summary: bool = False
    provider: str | None = None


class MemoryGraphWriteResult(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    user_id_hash: str
    saved: bool = False
    memory_updated: bool = False
    version: int = 1
    provider: str | None = None


# ═══════════════════════════════════════════════════════════════
# Legacy Flat Types (backward compat — auto-migrated to graph)
# ═══════════════════════════════════════════════════════════════

class MemoryItem(BaseModel):
    """
    A single sanitized memory fact (legacy v1/v2 format).

    Store compact support context only. Do not store raw chat logs, secrets,
    full addresses, phone numbers, or emails.
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    item_id: str | None = Field(default=None, max_length=120)
    category: LegacyMemoryCategory = LegacyMemoryCategory.OTHER
    text: str = Field(min_length=1, max_length=MAX_MEMORY_ITEM_TEXT_CHARS)
    source: MemorySource = MemorySource.UNKNOWN
    sensitivity: MemorySensitivity = MemorySensitivity.MEDIUM
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)
    tags: list[str] = Field(default_factory=list, max_length=MAX_MEMORY_LIST_ITEMS)
    vector: list[float] | None = Field(default=None)
    metadata: dict[str, str | int | float | bool | None] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=_utcnow)
    expires_at: datetime | None = None

    @field_validator("item_id", mode="before")
    @classmethod
    def _clean_optional_id(cls, value: object) -> str | None:
        if value is None:
            return None
        cleaned = sanitize_text(str(value), 120)
        return cleaned or None

    @field_validator("text", mode="before")
    @classmethod
    def _clean_text(cls, value: object) -> str:
        cleaned = _sanitize_memory_text(str(value or ""), MAX_MEMORY_ITEM_TEXT_CHARS)
        if not cleaned:
            raise ValueError("memory item text cannot be empty")
        return cleaned

    @field_validator("tags", mode="before")
    @classmethod
    def _clean_tags(cls, value: object) -> list[str]:
        return _sanitize_string_list(value, max_items=MAX_MEMORY_LIST_ITEMS)

    @field_validator("metadata", mode="before")
    @classmethod
    def _clean_metadata(cls, value: object) -> dict[str, str | int | float | bool | None]:
        return sanitize_metadata(value)

    @model_validator(mode="after")
    def _validate_expiry(self) -> MemoryItem:
        if self.expires_at is not None and self.expires_at <= self.created_at:
            raise ValueError("expires_at must be after created_at")
        return self


class ImportantPerson(BaseModel):
    """
    A durable person reference with aliases (legacy v1/v2 format).
    Also used by graph→summary conversion.
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    canonical_name: str = Field(min_length=1, max_length=MAX_MEMORY_SHORT_TEXT_CHARS)
    aliases: list[str] = Field(default_factory=list, max_length=MAX_MEMORY_ALIAS_ITEMS)
    relationship: str = Field(default="", max_length=MAX_MEMORY_SHORT_TEXT_CHARS)
    notes: list[str] = Field(default_factory=list, max_length=MAX_MEMORY_LIST_ITEMS)
    confidence: float = Field(default=0.7, ge=0.0, le=1.0)
    updated_at: datetime = Field(default_factory=_utcnow)

    @field_validator("canonical_name", "relationship", mode="before")
    @classmethod
    def _clean_short_text(cls, value: object) -> str:
        return _sanitize_memory_text(str(value or ""), MAX_MEMORY_SHORT_TEXT_CHARS)

    @field_validator("aliases", "notes", mode="before")
    @classmethod
    def _clean_lists(cls, value: object) -> list[str]:
        return _sanitize_string_list(value, max_items=MAX_MEMORY_LIST_ITEMS)

    @model_validator(mode="after")
    def _ensure_canonical_alias(self) -> ImportantPerson:
        self.aliases = _sanitize_string_list(
            [self.canonical_name, *self.aliases],
            max_items=MAX_MEMORY_ALIAS_ITEMS,
        )
        return self


class RelationshipFact(BaseModel):
    """A compact durable relationship-context fact."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    summary: str = Field(min_length=1, max_length=MAX_MEMORY_ITEM_TEXT_CHARS)
    people: list[str] = Field(default_factory=list, max_length=MAX_MEMORY_ALIAS_ITEMS)
    confidence: float = Field(default=0.65, ge=0.0, le=1.0)
    updated_at: datetime = Field(default_factory=_utcnow)

    @field_validator("summary", mode="before")
    @classmethod
    def _clean_summary(cls, value: object) -> str:
        cleaned = _sanitize_memory_text(str(value or ""), MAX_MEMORY_ITEM_TEXT_CHARS)
        if not cleaned:
            raise ValueError("relationship fact summary cannot be empty")
        return cleaned

    @field_validator("people", mode="before")
    @classmethod
    def _clean_people(cls, value: object) -> list[str]:
        return _sanitize_string_list(value, max_items=MAX_MEMORY_ALIAS_ITEMS)


class CommunicationPreferences(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    tone: str = Field(default="", max_length=MAX_MEMORY_SHORT_TEXT_CHARS)
    language: str = Field(default="", max_length=MAX_MEMORY_SHORT_TEXT_CHARS)
    response_style: list[str] = Field(default_factory=list, max_length=MAX_MEMORY_LIST_ITEMS)
    avoid: list[str] = Field(default_factory=list, max_length=MAX_MEMORY_LIST_ITEMS)

    @field_validator("tone", "language", mode="before")
    @classmethod
    def _clean_short_text(cls, value: object) -> str:
        return _sanitize_memory_text(str(value or ""), MAX_MEMORY_SHORT_TEXT_CHARS)

    @field_validator("response_style", "avoid", mode="before")
    @classmethod
    def _clean_lists(cls, value: object) -> list[str]:
        return _sanitize_string_list(value, max_items=MAX_MEMORY_LIST_ITEMS)


class MemorySummary(BaseModel):
    """
    Legacy flat memory summary (v1/v2 format).

    Kept for backward compatibility. New code should use MemoryGraph.
    Duplicate fields (goals/user_goals, etc.) are kept for stored-data compat.
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    user_id_hash: str = Field(min_length=1, max_length=80)
    preferred_name: str | None = Field(default=None, max_length=MAX_MEMORY_SHORT_TEXT_CHARS)
    important_people: list[ImportantPerson] = Field(default_factory=list, max_length=MAX_MEMORY_LIST_ITEMS)
    relationship_facts: list[RelationshipFact] = Field(default_factory=list, max_length=MAX_MEMORY_LIST_ITEMS)
    communication_preferences: CommunicationPreferences = Field(default_factory=CommunicationPreferences)
    emotional_triggers: list[str] = Field(default_factory=list, max_length=MAX_MEMORY_LIST_ITEMS)
    # NOTE: user_goals duplicates goals — kept for backward compat
    user_goals: list[str] = Field(default_factory=list, max_length=MAX_MEMORY_LIST_ITEMS)
    avoided_responses: list[str] = Field(default_factory=list, max_length=MAX_MEMORY_LIST_ITEMS)
    summary: str = Field(default="", max_length=MAX_MEMORY_SUMMARY_CHARS)
    # NOTE: known_triggers duplicates emotional_triggers — kept for backward compat
    known_triggers: list[str] = Field(default_factory=list, max_length=MAX_MEMORY_LIST_ITEMS)
    preferred_coping_tools: list[str] = Field(default_factory=list, max_length=MAX_MEMORY_LIST_ITEMS)
    # NOTE: goals duplicates user_goals — kept for backward compat
    goals: list[str] = Field(default_factory=list, max_length=MAX_MEMORY_LIST_ITEMS)
    # NOTE: preferences list overlaps with communication_preferences — kept for backward compat
    preferences: list[str] = Field(default_factory=list, max_length=MAX_MEMORY_LIST_ITEMS)
    safety_flags: list[str] = Field(default_factory=list, max_length=MAX_MEMORY_LIST_ITEMS)
    items: list[MemoryItem] = Field(default_factory=list, max_length=MAX_MEMORY_LIST_ITEMS)
    last_safety_level: SafetyLevel | None = None
    source: MemorySource = MemorySource.CHAT_COMPACTION
    version: int = Field(default=1, ge=1)
    updated_at: datetime = Field(default_factory=_utcnow)

    @field_validator("user_id_hash", mode="before")
    @classmethod
    def _clean_user_hash(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), 80)
        if not cleaned:
            raise ValueError("user_id_hash cannot be empty")
        return cleaned

    @field_validator("summary", mode="before")
    @classmethod
    def _clean_summary(cls, value: object) -> str:
        return _sanitize_memory_text(str(value or ""), MAX_MEMORY_SUMMARY_CHARS)

    @field_validator("preferred_name", mode="before")
    @classmethod
    def _clean_preferred_name(cls, value: object) -> str | None:
        if value is None:
            return None
        cleaned = _sanitize_memory_text(str(value or ""), MAX_MEMORY_SHORT_TEXT_CHARS)
        return cleaned or None

    @field_validator(
        "known_triggers",
        "emotional_triggers",
        "preferred_coping_tools",
        "goals",
        "user_goals",
        "preferences",
        "avoided_responses",
        "safety_flags",
        mode="before",
    )
    @classmethod
    def _clean_summary_lists(cls, value: object) -> list[str]:
        return _sanitize_string_list(value, max_items=MAX_MEMORY_LIST_ITEMS)

    def is_empty(self) -> bool:
        return not any(
            [
                self.summary,
                self.preferred_name,
                self.important_people,
                self.relationship_facts,
                self.communication_preferences.tone,
                self.communication_preferences.language,
                self.communication_preferences.response_style,
                self.communication_preferences.avoid,
                self.emotional_triggers,
                self.user_goals,
                self.avoided_responses,
                self.known_triggers,
                self.preferred_coping_tools,
                self.goals,
                self.preferences,
                self.safety_flags,
                self.items,
            ]
        )


# ═══════════════════════════════════════════════════════════════
# Request/Response Types
# ═══════════════════════════════════════════════════════════════

class MemoryInteraction(BaseModel):
    """Bounded, sanitized interaction fragment used only for compaction."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    role: MemoryInteractionRole
    content: str = Field(min_length=1, max_length=MAX_MEMORY_INTERACTION_CHARS)
    created_at: datetime = Field(default_factory=_utcnow)

    @field_validator("content", mode="before")
    @classmethod
    def _clean_content(cls, value: object) -> str:
        cleaned = _sanitize_memory_text(str(value or ""), MAX_MEMORY_INTERACTION_CHARS)
        if not cleaned:
            raise ValueError("interaction content cannot be empty")
        return cleaned


class MemoryCompactionRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    request_id: str = Field(min_length=1, max_length=80)
    user_id_hash: str = Field(min_length=1, max_length=80)
    existing_summary: MemorySummary | None = None
    interactions: list[MemoryInteraction] = Field(
        default_factory=list,
        max_length=MAX_MEMORY_INTERACTIONS,
    )
    locale: Locale = "auto"
    force: bool = False

    @field_validator("request_id", "user_id_hash", mode="before")
    @classmethod
    def _clean_short_text(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), 80)
        if not cleaned:
            raise ValueError("field cannot be empty")
        return cleaned

    @field_validator("locale", mode="before")
    @classmethod
    def _normalize_locale(cls, value: object) -> Locale:
        return normalize_locale(str(value)) if value is not None else "auto"

    @model_validator(mode="after")
    def _require_work(self) -> MemoryCompactionRequest:
        if not self.force and not self.interactions:
            raise ValueError("interactions are required unless force=true")
        return self


class MemoryCompactionResult(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    request_id: str = Field(min_length=1, max_length=80)
    user_id_hash: str = Field(min_length=1, max_length=80)
    summary: MemorySummary
    changed: bool = False
    items_added: int = Field(default=0, ge=0, le=MAX_MEMORY_LIST_ITEMS)

    @field_validator("request_id", "user_id_hash", mode="before")
    @classmethod
    def _clean_short_text(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), 80)
        if not cleaned:
            raise ValueError("field cannot be empty")
        return cleaned


class MemoryLoadResult(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    user_id_hash: str = Field(min_length=1, max_length=80)
    loaded: bool = False
    source: MemorySource = MemorySource.UNKNOWN
    summary: MemorySummary | None = None

    @field_validator("user_id_hash", mode="before")
    @classmethod
    def _clean_user_hash(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), 80)
        if not cleaned:
            raise ValueError("user_id_hash cannot be empty")
        return cleaned


class MemoryWriteResult(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    user_id_hash: str = Field(min_length=1, max_length=80)
    saved: bool = False
    provider: str = Field(default="mock", min_length=1, max_length=80)
    memory_updated: bool = False
    error_code: str | None = Field(default=None, max_length=120)

    @field_validator("user_id_hash", "provider", "error_code", mode="before")
    @classmethod
    def _clean_optional_short_text(cls, value: object) -> object:
        if value is None:
            return None
        cleaned = sanitize_text(str(value), 120)
        return cleaned or None


# ═══════════════════════════════════════════════════════════════
# Graph Utility Functions
# ═══════════════════════════════════════════════════════════════

def normalize_memory_value(value: str) -> str:
    """Normalize a memory value for deduplication matching."""
    cleaned = sanitize_text(str(value or ""), MAX_ATOM_TEXT_CHARS).lower()
    cleaned = re.sub(r"[^\w\u0600-\u06ff\s-]+", " ", cleaned, flags=re.UNICODE)
    cleaned = re.sub(r"\b(?:please|pls|response|responses|answer|answers)\b", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def canonical_memory_key(category: str, value: str, metadata: dict[str, Any] | None = None) -> str:
    """Generate a canonical deduplication key for a memory atom."""
    normalized = normalize_memory_value(value)
    category_key = sanitize_text(str(category or MemoryCategory.FACTS.value), MAX_ATOM_SHORT_CHARS).lower()
    role = sanitize_text(str((metadata or {}).get("relationship") or ""), MAX_ATOM_SHORT_CHARS).lower()
    field = sanitize_text(str((metadata or {}).get("field") or ""), MAX_ATOM_SHORT_CHARS).lower()
    basis = "|".join(part for part in (category_key, field, role, normalized) if part)
    digest = hashlib.sha256(basis.encode("utf-8")).hexdigest()[:20]
    return f"{category_key}:{digest}"


def make_memory_atom(
    *,
    user_id_hash: str,
    category: MemoryCategory,
    value: str,
    display_value: str | None = None,
    confidence: float = 0.6,
    source: MemorySource = MemorySource.CHAT_EXTRACTION,
    sensitivity: MemorySensitivity = MemorySensitivity.MEDIUM,
    aliases: list[str] | None = None,
    metadata: dict[str, str | int | float | bool | None] | None = None,
    pinned: bool = False,
    status: MemoryStatus = MemoryStatus.ACTIVE,
) -> MemoryAtom:
    """Factory function to create a properly keyed MemoryAtom."""
    metadata = metadata or {}
    normalized = normalize_memory_value(value)
    key = canonical_memory_key(category.value, value, metadata)
    atom_id = f"mem_{hashlib.sha256((user_id_hash + '|' + key).encode('utf-8')).hexdigest()[:24]}"
    now = utcnow()
    return MemoryAtom(
        id=atom_id,
        category=category,
        key=key,
        value=value,
        normalized_value=normalized,
        display_value=display_value or value,
        confidence=max(0.0, min(float(confidence), 1.0)),
        sensitivity=sensitivity,
        source=source,
        status=status,
        pinned=pinned,
        created_at=now,
        updated_at=now,
        last_seen_at=now,
        evidence_count=1,
        aliases=aliases or [],
        metadata=metadata,
    )


# ═══════════════════════════════════════════════════════════════
# Conversion Functions (Graph ↔ Legacy Summary)
# ═══════════════════════════════════════════════════════════════

def memory_graph_from_summary(summary: MemorySummary) -> MemoryGraph:
    """Convert a legacy MemorySummary into a MemoryGraph (lazy migration)."""
    atoms: list[MemoryAtom] = []
    user_id_hash = summary.user_id_hash

    if summary.preferred_name:
        atoms.append(make_memory_atom(
            user_id_hash=user_id_hash,
            category=MemoryCategory.PROFILE,
            value=summary.preferred_name,
            display_value=f"Preferred name: {summary.preferred_name}",
            confidence=0.9,
            source=_source_from_legacy(summary.source),
            sensitivity=MemorySensitivity.LOW,
            metadata={"field": "preferred_name"},
        ))

    for person in summary.important_people:
        aliases = [alias for alias in person.aliases if alias]
        label = " / ".join(aliases or [person.canonical_name])
        if person.relationship:
            label = f"{label} - {person.relationship}"
        atoms.append(make_memory_atom(
            user_id_hash=user_id_hash,
            category=MemoryCategory.PEOPLE,
            value=person.canonical_name,
            display_value=label,
            confidence=person.confidence,
            source=_source_from_legacy(summary.source),
            sensitivity=MemorySensitivity.MEDIUM,
            aliases=aliases,
            metadata={"relationship": person.relationship},
        ))

    for fact in summary.relationship_facts:
        atoms.append(make_memory_atom(
            user_id_hash=user_id_hash,
            category=MemoryCategory.RELATIONSHIP_CONTEXT,
            value=fact.summary,
            confidence=fact.confidence,
            source=_source_from_legacy(summary.source),
            sensitivity=MemorySensitivity.MEDIUM,
            aliases=fact.people,
        ))

    prefs = summary.communication_preferences
    for value in prefs.response_style:
        atoms.append(make_memory_atom(
            user_id_hash=user_id_hash,
            category=MemoryCategory.PREFERENCES,
            value=value,
            confidence=0.78,
            source=_source_from_legacy(summary.source),
            sensitivity=MemorySensitivity.LOW,
        ))
    if prefs.tone:
        atoms.append(make_memory_atom(
            user_id_hash=user_id_hash,
            category=MemoryCategory.PREFERENCES,
            value=f"{prefs.tone} tone",
            confidence=0.78,
            source=_source_from_legacy(summary.source),
            sensitivity=MemorySensitivity.LOW,
        ))
    if prefs.language:
        atoms.append(make_memory_atom(
            user_id_hash=user_id_hash,
            category=MemoryCategory.PREFERENCES,
            value=prefs.language,
            confidence=0.82,
            source=_source_from_legacy(summary.source),
            sensitivity=MemorySensitivity.LOW,
        ))

    for value in [*prefs.avoid, *summary.avoided_responses]:
        atoms.append(make_memory_atom(
            user_id_hash=user_id_hash,
            category=MemoryCategory.AVOID,
            value=value,
            confidence=0.82,
            source=_source_from_legacy(summary.source),
            sensitivity=MemorySensitivity.LOW,
        ))

    for value in [*summary.emotional_triggers, *summary.known_triggers]:
        atoms.append(make_memory_atom(
            user_id_hash=user_id_hash,
            category=MemoryCategory.PATTERNS,
            value=value,
            confidence=0.65,
            source=_source_from_legacy(summary.source),
            sensitivity=MemorySensitivity.MEDIUM,
        ))

    for value in [*summary.user_goals, *summary.goals]:
        atoms.append(make_memory_atom(
            user_id_hash=user_id_hash,
            category=MemoryCategory.GOALS,
            value=value,
            confidence=0.7,
            source=_source_from_legacy(summary.source),
            sensitivity=MemorySensitivity.LOW,
        ))

    for value in summary.preferred_coping_tools:
        atoms.append(make_memory_atom(
            user_id_hash=user_id_hash,
            category=MemoryCategory.COPING_TOOLS,
            value=value,
            confidence=0.7,
            source=_source_from_legacy(summary.source),
            sensitivity=MemorySensitivity.LOW,
        ))

    for value in summary.safety_flags:
        atoms.append(make_memory_atom(
            user_id_hash=user_id_hash,
            category=MemoryCategory.SAFETY_CONTEXT,
            value=value,
            confidence=0.7,
            source=_source_from_legacy(summary.source),
            sensitivity=MemorySensitivity.HIGH,
        ))

    for item in summary.items:
        atoms.append(_atom_from_legacy_item(user_id_hash, item, summary.source))

    return MemoryGraph(
        user_id_hash=user_id_hash,
        atoms=atoms,
        version=max(1, summary.version),
        source=_source_from_legacy(summary.source),
        full_snapshot=True,
    )


def summary_from_memory_graph(graph: MemoryGraph) -> MemorySummary:
    """Convert a MemoryGraph back into a legacy MemorySummary."""
    active = graph.active_atoms
    preferred_name = _first_value(active, MemoryCategory.PROFILE, field="preferred_name")
    people = [
        ImportantPerson(
            canonical_name=atom.value,
            aliases=atom.aliases or [atom.value],
            relationship=str(atom.metadata.get("relationship") or ""),
            confidence=atom.confidence,
            updated_at=atom.updated_at,
        )
        for atom in active
        if atom.category == MemoryCategory.PEOPLE
    ]
    relationship_facts = [
        RelationshipFact(
            summary=atom.value,
            people=atom.aliases,
            confidence=atom.confidence,
            updated_at=atom.updated_at,
        )
        for atom in active
        if atom.category == MemoryCategory.RELATIONSHIP_CONTEXT
    ]
    preferences = [atom.value for atom in active if atom.category == MemoryCategory.PREFERENCES]
    avoid = [atom.value for atom in active if atom.category == MemoryCategory.AVOID]

    return MemorySummary(
        user_id_hash=graph.user_id_hash,
        preferred_name=preferred_name,
        important_people=people,
        relationship_facts=relationship_facts,
        communication_preferences=CommunicationPreferences(
            tone=_extract_preference_tone(active),
            language=_extract_preference_language(active),
            response_style=preferences,
            avoid=avoid,
        ),
        emotional_triggers=[atom.value for atom in active if atom.category == MemoryCategory.PATTERNS],
        user_goals=[atom.value for atom in active if atom.category == MemoryCategory.GOALS],
        avoided_responses=avoid,
        known_triggers=[atom.value for atom in active if atom.category == MemoryCategory.PATTERNS],
        preferred_coping_tools=[atom.value for atom in active if atom.category == MemoryCategory.COPING_TOOLS],
        goals=[atom.value for atom in active if atom.category == MemoryCategory.GOALS],
        preferences=preferences,
        safety_flags=[atom.value for atom in active if atom.category == MemoryCategory.SAFETY_CONTEXT],
        items=[],
        version=max(1, graph.version),
    )


# ═══════════════════════════════════════════════════════════════
# Prompt Building
# ═══════════════════════════════════════════════════════════════

def build_memory_prompt_from_graph(graph: MemoryGraph) -> str:
    """Build the memory prompt string for LLM context injection."""
    sections = grouped_active_atoms(graph)
    if not sections:
        return ""

    labels = {
        MemoryCategory.PROFILE: "Profile",
        MemoryCategory.PEOPLE: "People",
        MemoryCategory.PROJECTS: "Projects",
        MemoryCategory.PREFERENCES: "Preferences",
        MemoryCategory.AVOID: "Avoid",
        MemoryCategory.PATTERNS: "Patterns",
        MemoryCategory.GOALS: "Goals",
        MemoryCategory.RELATIONSHIP_CONTEXT: "Relationship context",
        MemoryCategory.COPING_TOOLS: "Coping tools",
        MemoryCategory.SAFETY_CONTEXT: "Safety context",
        MemoryCategory.FACTS: "Other facts",
    }
    order = [
        MemoryCategory.PROFILE,
        MemoryCategory.PEOPLE,
        MemoryCategory.PROJECTS,
        MemoryCategory.PREFERENCES,
        MemoryCategory.AVOID,
        MemoryCategory.PATTERNS,
        MemoryCategory.GOALS,
        MemoryCategory.RELATIONSHIP_CONTEXT,
        MemoryCategory.COPING_TOOLS,
        MemoryCategory.SAFETY_CONTEXT,
        MemoryCategory.FACTS,
    ]
    lines = [
        "Saved user memory:",
        "Use memory only when relevant. Do not mention memory unless the user asks or it clearly helps. Do not expose sensitive memory unnecessarily.",
    ]

    for category in order:
        atoms = sections.get(category, [])
        if not atoms:
            continue
        lines.append(f"{labels[category]}:")
        for atom in atoms[:8]:
            lines.append(f"- {atom.display_value or atom.value}")

    return "\n".join(lines[:80])


def grouped_active_atoms(graph: MemoryGraph) -> dict[MemoryCategory, list[MemoryAtom]]:
    """Group active atoms by category, sorted by relevance."""
    grouped: dict[MemoryCategory, list[MemoryAtom]] = {}
    for atom in graph.atoms:
        if atom.status != MemoryStatus.ACTIVE:
            continue
        grouped.setdefault(atom.category, []).append(atom)
    for atoms in grouped.values():
        atoms.sort(key=lambda item: (not item.pinned, -item.confidence, item.display_value.lower()))
    return grouped


# ═══════════════════════════════════════════════════════════════
# Internal Helpers
# ═══════════════════════════════════════════════════════════════

def _sanitize_string_list(value: object, *, max_items: int) -> list[str]:
    """Thin wrapper around shared helper with memory-specific defaults."""
    return _sanitize_string_list_helper(
        value,
        max_items=max_items,
        max_item_chars=MAX_MEMORY_LIST_ITEM_CHARS,
        redact_pii=True,
    )


def _sanitize_metadata(value: object) -> dict[str, str | int | float | bool | None]:
    """Thin wrapper around shared helper."""
    return sanitize_metadata(
        value,
        max_items=MAX_METADATA_ITEMS,
        max_value_chars=MAX_METADATA_VALUE_CHARS,
    )


def _clean_graph_string_list(value: object, *, max_items: int) -> list[str]:
    """Deduplicate using normalized values (for graph atom aliases/IDs)."""
    if value is None:
        return []
    raw = value if isinstance(value, list) else [value]
    output: list[str] = []
    seen: set[str] = set()
    for item in raw[:max_items]:
        cleaned = sanitize_text(str(item or ""), MAX_ATOM_SHORT_CHARS)
        key = normalize_memory_value(cleaned)
        if not cleaned or key in seen:
            continue
        seen.add(key)
        output.append(cleaned)
    return output


def _source_from_legacy(source: MemorySource) -> MemorySource:
    """Map legacy MemorySource values to graph sources."""
    _legacy_map: dict[MemorySource, MemorySource] = {
        MemorySource.MANUAL: MemorySource.MANUAL,
        MemorySource.USER_PROFILE: MemorySource.PROFILE,
        MemorySource.IMPORT: MemorySource.IMPORT,
        MemorySource.CHAT_COMPACTION: MemorySource.BACKEND_COMPACTION,
        MemorySource.SAFETY_EVENT: MemorySource.BACKEND_COMPACTION,
        MemorySource.UNKNOWN: MemorySource.BACKEND_COMPACTION,
    }
    return _legacy_map.get(source, MemorySource.BACKEND_COMPACTION)


def _atom_from_legacy_item(user_id_hash: str, item: MemoryItem, source: MemorySource) -> MemoryAtom:
    """Convert a legacy MemoryItem into a MemoryAtom."""
    category = {
        "trigger": MemoryCategory.PATTERNS,
        "coping_tool": MemoryCategory.COPING_TOOLS,
        "goal": MemoryCategory.GOALS,
        "preference": MemoryCategory.PREFERENCES,
        "safety_flag": MemoryCategory.SAFETY_CONTEXT,
        "support_context": MemoryCategory.FACTS,
        "life_event": MemoryCategory.FACTS,
    }.get(str(item.category.value), MemoryCategory.FACTS)
    return make_memory_atom(
        user_id_hash=user_id_hash,
        category=category,
        value=item.text,
        confidence=item.confidence,
        source=_source_from_legacy(source),
        sensitivity=item.sensitivity,
        metadata={"legacy_category": item.category.value},
    )


def _first_value(
    atoms: list[MemoryAtom],
    category: MemoryCategory,
    *,
    field: str,
) -> str | None:
    """Find the first atom value matching a category and metadata field."""
    for atom in atoms:
        if atom.category == category and atom.metadata.get("field") == field:
            return atom.value
    return None


def _extract_preference_tone(atoms: list[MemoryAtom]) -> str:
    """Extract tone preference from atoms."""
    for atom in atoms:
        if atom.category != MemoryCategory.PREFERENCES:
            continue
        if atom.metadata.get("field") == "tone":
            return atom.value
    tone_keywords = ("direct", "gentle", "casual", "formal", "warm", "empathetic")
    for atom in atoms:
        if atom.category != MemoryCategory.PREFERENCES:
            continue
        normalized = atom.normalized_value.lower()
        for keyword in tone_keywords:
            if keyword in normalized:
                return keyword
    return ""


def _extract_preference_language(atoms: list[MemoryAtom]) -> str:
    """Extract preferred language from atoms."""
    for atom in atoms:
        if atom.category != MemoryCategory.PREFERENCES:
            continue
        if atom.metadata.get("field") == "language":
            return atom.value
    language_keywords = ("arabic", "english", "french", "spanish", "german", "turkish", "hebrew")
    for atom in atoms:
        if atom.category != MemoryCategory.PREFERENCES:
            continue
        normalized = atom.normalized_value.lower()
        for keyword in language_keywords:
            if keyword in normalized:
                return atom.value
    return ""
