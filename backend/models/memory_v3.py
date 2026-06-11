from __future__ import annotations

import hashlib
import re
from datetime import UTC, datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from backend.core.security import sanitize_text
from backend.models.memory import (
    CommunicationPreferences,
    ImportantPerson,
    MemoryItem,
    MemorySensitivity as LegacyMemorySensitivity,
    MemorySource as LegacyMemorySource,
    MemorySummary,
    RelationshipFact,
)


MAX_ATOMS = 500
MAX_ATOM_TEXT_CHARS = 700
MAX_ATOM_SHORT_CHARS = 180
MAX_ALIASES = 30
MAX_METADATA_ITEMS = 40


class MemoryCategory(str, Enum):
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


class MemorySource(str, Enum):
    MANUAL = "manual"
    CHAT_EXTRACTION = "chat_extraction"
    BACKEND_COMPACTION = "backend_compaction"
    PROFILE = "profile"
    IMPORT = "import"


class MemoryStatus(str, Enum):
    ACTIVE = "active"
    ARCHIVED = "archived"
    DELETED = "deleted"


class MemorySensitivity(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


def utcnow() -> datetime:
    return datetime.now(UTC)


class MemoryAtom(BaseModel):
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
        return _clean_string_list(value, max_items=MAX_ALIASES)

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


class MemoryGraph(BaseModel):
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


class MemoryGraphPatch(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    atoms: list[MemoryAtom] = Field(default_factory=list, max_length=MAX_ATOMS)
    deleted_atom_ids: list[str] = Field(default_factory=list, max_length=MAX_ATOMS)
    full_snapshot: bool = False

    @field_validator("deleted_atom_ids", mode="before")
    @classmethod
    def _clean_ids(cls, value: object) -> list[str]:
        return _clean_string_list(value, max_items=MAX_ATOMS)


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


def normalize_memory_value(value: str) -> str:
    cleaned = sanitize_text(str(value or ""), MAX_ATOM_TEXT_CHARS).lower()
    cleaned = re.sub(r"[^\w\u0600-\u06ff\s-]+", " ", cleaned, flags=re.UNICODE)
    cleaned = re.sub(r"\b(?:please|pls|response|responses|answer|answers)\b", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def canonical_memory_key(category: str, value: str, metadata: dict[str, Any] | None = None) -> str:
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


def memory_graph_from_summary(summary: MemorySummary) -> MemoryGraph:
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
    active_atoms = [atom for atom in graph.atoms if atom.status == MemoryStatus.ACTIVE]
    preferred_name = _first_value(active_atoms, MemoryCategory.PROFILE, field="preferred_name")
    people = [
        ImportantPerson(
            canonical_name=atom.value,
            aliases=atom.aliases or [atom.value],
            relationship=str(atom.metadata.get("relationship") or ""),
            confidence=atom.confidence,
            updated_at=atom.updated_at,
        )
        for atom in active_atoms
        if atom.category == MemoryCategory.PEOPLE
    ]
    relationship_facts = [
        RelationshipFact(
            summary=atom.value,
            people=atom.aliases,
            confidence=atom.confidence,
            updated_at=atom.updated_at,
        )
        for atom in active_atoms
        if atom.category == MemoryCategory.RELATIONSHIP_CONTEXT
    ]
    preferences = [atom.value for atom in active_atoms if atom.category == MemoryCategory.PREFERENCES]
    avoid = [atom.value for atom in active_atoms if atom.category == MemoryCategory.AVOID]

    return MemorySummary(
        user_id_hash=graph.user_id_hash,
        preferred_name=preferred_name,
        important_people=people,
        relationship_facts=relationship_facts,
        communication_preferences=CommunicationPreferences(
            tone="direct" if any("direct" in atom.normalized_value for atom in active_atoms if atom.category == MemoryCategory.PREFERENCES) else "",
            language=next((atom.value for atom in active_atoms if atom.category == MemoryCategory.PREFERENCES and "arabic" in atom.normalized_value), ""),
            response_style=preferences,
            avoid=avoid,
        ),
        emotional_triggers=[atom.value for atom in active_atoms if atom.category == MemoryCategory.PATTERNS],
        user_goals=[atom.value for atom in active_atoms if atom.category == MemoryCategory.GOALS],
        avoided_responses=avoid,
        known_triggers=[atom.value for atom in active_atoms if atom.category == MemoryCategory.PATTERNS],
        preferred_coping_tools=[atom.value for atom in active_atoms if atom.category == MemoryCategory.COPING_TOOLS],
        goals=[atom.value for atom in active_atoms if atom.category == MemoryCategory.GOALS],
        preferences=preferences,
        safety_flags=[atom.value for atom in active_atoms if atom.category == MemoryCategory.SAFETY_CONTEXT],
        items=[],
        version=max(1, graph.version),
    )


def build_memory_prompt_from_graph(graph: MemoryGraph) -> str:
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
    grouped: dict[MemoryCategory, list[MemoryAtom]] = {}
    for atom in graph.atoms:
        if atom.status != MemoryStatus.ACTIVE:
            continue
        grouped.setdefault(atom.category, []).append(atom)
    for atoms in grouped.values():
        atoms.sort(key=lambda item: (not item.pinned, -item.confidence, item.display_value.lower()))
    return grouped


def _atom_from_legacy_item(user_id_hash: str, item: MemoryItem, source: LegacyMemorySource) -> MemoryAtom:
    category = {
        "trigger": MemoryCategory.PATTERNS,
        "coping_tool": MemoryCategory.COPING_TOOLS,
        "goal": MemoryCategory.GOALS,
        "preference": MemoryCategory.PREFERENCES,
        "safety_flag": MemoryCategory.SAFETY_CONTEXT,
        "support_context": MemoryCategory.FACTS,
        "life_event": MemoryCategory.FACTS,
    }.get(str(item.category.value), MemoryCategory.FACTS)
    sensitivity = {
        LegacyMemorySensitivity.LOW: MemorySensitivity.LOW,
        LegacyMemorySensitivity.MEDIUM: MemorySensitivity.MEDIUM,
        LegacyMemorySensitivity.HIGH: MemorySensitivity.HIGH,
    }.get(item.sensitivity, MemorySensitivity.MEDIUM)
    return make_memory_atom(
        user_id_hash=user_id_hash,
        category=category,
        value=item.text,
        confidence=item.confidence,
        source=_source_from_legacy(source),
        sensitivity=sensitivity,
        metadata={"legacy_category": item.category.value},
    )


def _source_from_legacy(source: LegacyMemorySource) -> MemorySource:
    if source == LegacyMemorySource.MANUAL:
        return MemorySource.MANUAL
    if source == LegacyMemorySource.USER_PROFILE:
        return MemorySource.PROFILE
    if source == LegacyMemorySource.IMPORT:
        return MemorySource.IMPORT
    return MemorySource.BACKEND_COMPACTION


def _first_value(
    atoms: list[MemoryAtom],
    category: MemoryCategory,
    *,
    field: str,
) -> str | None:
    for atom in atoms:
        if atom.category == category and atom.metadata.get("field") == field:
            return atom.value
    return None


def _clean_string_list(value: object, *, max_items: int) -> list[str]:
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
