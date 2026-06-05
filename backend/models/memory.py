# backend/models/memory.py

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from backend.core.security import (
    Locale,
    normalize_locale,
    redact_basic_pii,
    safe_truncate,
    sanitize_text,
)
from backend.models.safety import SafetyLevel


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


class MemoryCategory(str, Enum):
    TRIGGER = "trigger"
    COPING_TOOL = "coping_tool"
    GOAL = "goal"
    PREFERENCE = "preference"
    SAFETY_FLAG = "safety_flag"
    LIFE_EVENT = "life_event"
    SUPPORT_CONTEXT = "support_context"
    OTHER = "other"


class MemorySource(str, Enum):
    CHAT_COMPACTION = "chat_compaction"
    USER_PROFILE = "user_profile"
    SAFETY_EVENT = "safety_event"
    MANUAL = "manual"
    IMPORT = "import"
    UNKNOWN = "unknown"


class MemorySensitivity(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class MemoryInteractionRole(str, Enum):
    USER = "user"
    ASSISTANT = "assistant"


def _utcnow() -> datetime:
    return datetime.now(UTC)


class MemoryItem(BaseModel):
    """
    A single sanitized memory fact.

    Store compact support context only. Do not store raw chat logs, secrets,
    full addresses, phone numbers, or emails.
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    item_id: str | None = Field(default=None, max_length=120)
    category: MemoryCategory = MemoryCategory.OTHER
    text: str = Field(min_length=1, max_length=MAX_MEMORY_ITEM_TEXT_CHARS)
    source: MemorySource = MemorySource.UNKNOWN
    sensitivity: MemorySensitivity = MemorySensitivity.MEDIUM
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)
    tags: list[str] = Field(default_factory=list, max_length=MAX_MEMORY_LIST_ITEMS)
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
        return _sanitize_metadata(value)

    @model_validator(mode="after")
    def _validate_expiry(self) -> MemoryItem:
        if self.expires_at is not None and self.expires_at <= self.created_at:
            raise ValueError("expires_at must be after created_at")
        return self


class ImportantPerson(BaseModel):
    """
    A durable person reference with aliases.

    This stores only support-relevant relationship context. It must not store
    direct contact details, addresses, or private identifiers.
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
    """
    A compact durable relationship-context fact.
    """

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
    Sanitized long-term memory summary stored per user.

    raw chat messages are intentionally absent.
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    user_id_hash: str = Field(min_length=1, max_length=80)
    preferred_name: str | None = Field(default=None, max_length=MAX_MEMORY_SHORT_TEXT_CHARS)
    important_people: list[ImportantPerson] = Field(default_factory=list, max_length=MAX_MEMORY_LIST_ITEMS)
    relationship_facts: list[RelationshipFact] = Field(default_factory=list, max_length=MAX_MEMORY_LIST_ITEMS)
    communication_preferences: CommunicationPreferences = Field(default_factory=CommunicationPreferences)
    emotional_triggers: list[str] = Field(default_factory=list, max_length=MAX_MEMORY_LIST_ITEMS)
    user_goals: list[str] = Field(default_factory=list, max_length=MAX_MEMORY_LIST_ITEMS)
    avoided_responses: list[str] = Field(default_factory=list, max_length=MAX_MEMORY_LIST_ITEMS)
    summary: str = Field(default="", max_length=MAX_MEMORY_SUMMARY_CHARS)
    known_triggers: list[str] = Field(default_factory=list, max_length=MAX_MEMORY_LIST_ITEMS)
    preferred_coping_tools: list[str] = Field(default_factory=list, max_length=MAX_MEMORY_LIST_ITEMS)
    goals: list[str] = Field(default_factory=list, max_length=MAX_MEMORY_LIST_ITEMS)
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


class MemoryInteraction(BaseModel):
    """
    Bounded, sanitized interaction fragment used only for compaction.
    """

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


def _sanitize_memory_text(text: str, max_chars: int) -> str:
    cleaned = sanitize_text(text, max_chars)
    cleaned = redact_basic_pii(cleaned)
    return safe_truncate(cleaned, max_chars)


def _sanitize_string_list(value: object, *, max_items: int) -> list[str]:
    if value is None:
        return []

    if isinstance(value, str):
        raw_items: Sequence[object] = [value]
    elif isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        raw_items = value
    else:
        raw_items = [value]

    seen: set[str] = set()
    cleaned_items: list[str] = []

    for item in raw_items:
        cleaned = _sanitize_memory_text(str(item or ""), MAX_MEMORY_LIST_ITEM_CHARS)
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        cleaned_items.append(cleaned)
        if len(cleaned_items) >= max_items:
            break

    return cleaned_items


def _sanitize_metadata(value: object) -> dict[str, str | int | float | bool | None]:
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise TypeError("metadata must be a mapping")

    cleaned: dict[str, str | int | float | bool | None] = {}

    for raw_key, raw_value in list(value.items())[:MAX_METADATA_ITEMS]:
        key = sanitize_text(str(raw_key or ""), 80)
        if not key:
            continue

        if raw_value is None or isinstance(raw_value, (bool, int, float)):
            cleaned[key] = raw_value
        else:
            cleaned[key] = _sanitize_memory_text(str(raw_value), MAX_METADATA_VALUE_CHARS)

    return cleaned
