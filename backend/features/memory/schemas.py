# backend/features/memory/schemas.py

"""
Memory domain schemas, MemoryAtom, MemoryGraph, and taxonomy models.
"""

from __future__ import annotations

import functools
import hashlib
import math
import re
from datetime import UTC, datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from backend.core.security import sanitize_text

MAX_ATOMS = 500
MAX_ATOM_TEXT_CHARS = 700
MAX_ATOM_SHORT_CHARS = 180
MAX_ALIASES = 30
MAX_MEMORY_SUMMARY_CHARS = 4_000


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


class MemoryTier(str, Enum):
    IDENTITY = "identity"
    KNOWLEDGE = "knowledge"
    ARCHIVE = "archive"


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


class MemorySource(str, Enum):
    MANUAL = "manual"
    CHAT_EXTRACTION = "chat_extraction"
    BACKEND_COMPACTION = "backend_compaction"
    PROFILE = "profile"
    IMPORT = "import"
    VOICE_CALL = "voice_call"
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


class BrainEdgeType(str, Enum):
    RELATES_TO = "relates_to"
    AFFECTS = "affects"
    HELPS_WITH = "helps_with"
    BLOCKS = "blocks"
    PART_OF = "part_of"
    CONTRADICTS = "contradicts"
    SUPERSEDES = "supersedes"


class BrainEdgeStatus(str, Enum):
    ACTIVE = "active"
    HIDDEN = "hidden"
    DELETED = "deleted"


class BrainReviewKind(str, Enum):
    NEW = "new"
    STALE = "stale"
    CONFLICT = "conflict"
    EXPIRING = "expiring"


class BrainReviewStatus(str, Enum):
    PENDING = "pending"
    CONFIRMED = "confirmed"
    DISMISSED = "dismissed"
    DEFERRED = "deferred"


class BrainEdge(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    id: str = Field(min_length=1, max_length=160)
    source_atom_id: str = Field(min_length=1, max_length=160)
    target_atom_id: str = Field(min_length=1, max_length=160)
    relation: BrainEdgeType = BrainEdgeType.RELATES_TO
    confidence: float = Field(default=0.7, ge=0.0, le=1.0)
    status: BrainEdgeStatus = BrainEdgeStatus.ACTIVE
    source: MemorySource = MemorySource.MANUAL
    evidence_ids: list[str] = Field(default_factory=list, max_length=30)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    last_confirmed_at: datetime | None = None


class BrainEvidence(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    id: str = Field(min_length=1, max_length=160)
    source_atom_id: str = Field(min_length=1, max_length=160)
    excerpt: str = Field(min_length=1, max_length=500)
    source: str = Field(min_length=1, max_length=80)
    captured_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class BrainReviewRecord(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    id: str = Field(min_length=1, max_length=160)
    atom_id: str = Field(min_length=1, max_length=160)
    kind: BrainReviewKind = BrainReviewKind.NEW
    status: BrainReviewStatus = BrainReviewStatus.PENDING
    reason: str = Field(default="", max_length=300)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class MemoryAtom(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    id: str = Field(min_length=1, max_length=160)
    category: MemoryCategory = MemoryCategory.FACTS
    title: str = Field(default="", max_length=MAX_ATOM_SHORT_CHARS)
    value: str = Field(min_length=1, max_length=MAX_ATOM_TEXT_CHARS)
    confidence: float = Field(default=0.8, ge=0.0, le=1.0)
    source: MemorySource = MemorySource.CHAT_EXTRACTION
    sensitivity: MemorySensitivity = MemorySensitivity.LOW
    status: MemoryStatus = MemoryStatus.ACTIVE
    pinned: bool = False
    source_message_id: str | None = Field(default=None, max_length=160)
    evidence_atoms: list[str] = Field(default_factory=list, max_length=30)
    tags: list[str] = Field(default_factory=list, max_length=MAX_ALIASES)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    last_confirmed_at: datetime | None = None


class MemoryGraph(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    version: int = Field(default=1, ge=1)
    atoms: dict[str, MemoryAtom] = Field(default_factory=dict)
    edges: dict[str, BrainEdge] = Field(default_factory=dict)
    evidence: dict[str, BrainEvidence] = Field(default_factory=dict)
    reviews: dict[str, BrainReviewRecord] = Field(default_factory=dict)
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    def active_atoms(self) -> list[MemoryAtom]:
        return [a for a in self.atoms.values() if a.status == MemoryStatus.ACTIVE]

    def active_edges(self) -> list[BrainEdge]:
        return [e for e in self.edges.values() if e.status == BrainEdgeStatus.ACTIVE]


def make_memory_atom(
    *,
    id: str | None = None,
    category: MemoryCategory = MemoryCategory.FACTS,
    title: str = "",
    value: str,
    confidence: float = 0.8,
    source: MemorySource = MemorySource.CHAT_EXTRACTION,
    sensitivity: MemorySensitivity = MemorySensitivity.LOW,
    pinned: bool = False,
    tags: list[str] | None = None,
) -> MemoryAtom:
    atom_id = id or f"atom_{hashlib.sha256(value.encode()).hexdigest()[:16]}"
    return MemoryAtom(
        id=atom_id,
        category=category,
        title=title,
        value=value,
        confidence=confidence,
        source=source,
        sensitivity=sensitivity,
        pinned=pinned,
        tags=tags or [],
    )


@functools.lru_cache(maxsize=4096)
def normalize_memory_value(value: str) -> str:
    cleaned = sanitize_text(value, MAX_ATOM_TEXT_CHARS).lower()
    return re.sub(r"\s+", " ", cleaned).strip()
