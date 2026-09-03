# backend/models/understanding.py

"""
Pydantic models for MindPal message-level intelligence layer.

Defines schemas for:
- MessageUnderstanding: Per-user-message AI-generated derived understanding
- AssistantTelemetry: Per-assistant-response execution metrics & snapshot
- Dynamic Taxonomy: Emergent, AI-consolidated theme taxonomy per user and globally
- UserContextSnapshot: Re-synthesized natural-language situational portrait
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.core.security import sanitize_text
from backend.models._helpers import utcnow


MAX_UNDERSTANDING_TEXT_CHARS = 1_000
MAX_THEMES_PER_MESSAGE = 10
MAX_RATIONALE_CHARS = 1_000


class AnalysisStatus(str, Enum):
    ANALYZED = "analyzed"
    UNDER_ANALYZED = "under_analyzed"
    FAILED = "failed"


class MessageUnderstanding(BaseModel):
    """
    AI-generated derived understanding attached to a user message.
    Stores no raw message content (privacy-first).
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    schema_version: int = Field(default=1, ge=1, le=10)
    message_id: str = Field(min_length=1, max_length=160)
    user_id_hash: str = Field(min_length=1, max_length=120)
    emotional_state: str = Field(min_length=1, max_length=MAX_UNDERSTANDING_TEXT_CHARS)
    themes: list[str] = Field(default_factory=list, max_length=MAX_THEMES_PER_MESSAGE)
    significance: str = Field(min_length=1, max_length=MAX_UNDERSTANDING_TEXT_CHARS)
    memory_worthiness: float = Field(default=0.0, ge=0.0, le=1.0)
    memory_rationale: str = Field(default="", max_length=MAX_RATIONALE_CHARS)
    crisis_risk_assessment: str = Field(default="low", max_length=200)
    status: AnalysisStatus = AnalysisStatus.ANALYZED
    analyzed_at: datetime = Field(default_factory=utcnow)

    @field_validator("message_id", "user_id_hash", mode="before")
    @classmethod
    def _sanitize_ids(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), 160)
        if not cleaned:
            raise ValueError("ID fields cannot be empty")
        return cleaned

    @field_validator("emotional_state", "significance", "memory_rationale", "crisis_risk_assessment", mode="before")
    @classmethod
    def _sanitize_text_fields(cls, value: object) -> str:
        return sanitize_text(str(value or ""), MAX_UNDERSTANDING_TEXT_CHARS)

    @field_validator("themes", mode="before")
    @classmethod
    def _sanitize_themes(cls, value: object) -> list[str]:
        if not isinstance(value, list):
            return []
        cleaned: list[str] = []
        seen: set[str] = set()
        for item in value[:MAX_THEMES_PER_MESSAGE]:
            tag = sanitize_text(str(item or ""), 80).strip().lower()
            if tag and tag not in seen:
                seen.add(tag)
                cleaned.append(tag)
        return cleaned


class AssistantTelemetry(BaseModel):
    """
    Performance and execution telemetry for an AI response.
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    request_id: str = Field(min_length=1, max_length=120)
    latency_ms: float = Field(default=0.0, ge=0.0)
    model: str = Field(default="standard", max_length=120)
    personalization_snapshot: dict[str, Any] = Field(default_factory=dict)
    token_usage: dict[str, int] = Field(default_factory=dict)
    memory_injected: bool = False
    user_snapshot_injected: bool = False
    safety_path_triggered: str = Field(default="standard", max_length=80)
    completion_status: str = Field(default="completed", max_length=80)
    created_at: datetime = Field(default_factory=utcnow)

    @field_validator("request_id", "model", "safety_path_triggered", "completion_status", mode="before")
    @classmethod
    def _sanitize_short_text(cls, value: object) -> str:
        return sanitize_text(str(value or ""), 120)


class TaxonomyTheme(BaseModel):
    """
    An emergent topic label in the dynamic taxonomy.
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    name: str = Field(min_length=1, max_length=80)
    aliases: list[str] = Field(default_factory=list, max_length=20)
    occurrence_count: int = Field(default=1, ge=1)
    language: str = Field(default="english", max_length=20)
    first_seen_at: datetime = Field(default_factory=utcnow)
    last_seen_at: datetime = Field(default_factory=utcnow)

    @field_validator("name", mode="before")
    @classmethod
    def _sanitize_name(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), 80).strip().lower()
        if not cleaned:
            raise ValueError("Theme name cannot be empty")
        return cleaned


class UserTaxonomy(BaseModel):
    """
    Evolving topic model per user or globally.
    No hardcoded constants.
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    user_id_hash: str = Field(min_length=1, max_length=120)
    schema_version: int = Field(default=1, ge=1)
    version: int = Field(default=1, ge=1)
    themes: list[TaxonomyTheme] = Field(default_factory=list, max_length=200)
    updated_at: datetime = Field(default_factory=utcnow)

    @field_validator("user_id_hash", mode="before")
    @classmethod
    def _sanitize_user_hash(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), 120)
        if not cleaned:
            raise ValueError("user_id_hash cannot be empty")
        return cleaned


class UserContextSnapshot(BaseModel):
    """
    Living AI artifact representing the current situational portrait of the user.
    Re-synthesized when meaningful signal changes occur.
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    user_id_hash: str = Field(min_length=1, max_length=120)
    version: int = Field(default=1, ge=1)
    dominant_themes: list[str] = Field(default_factory=list, max_length=10)
    tone_trajectory: str = Field(default="", max_length=MAX_UNDERSTANDING_TEXT_CHARS)
    active_stressors: list[str] = Field(default_factory=list, max_length=10)
    what_helps: list[str] = Field(default_factory=list, max_length=10)
    situational_portrait: str = Field(default="", max_length=2_000)
    generated_at: datetime = Field(default_factory=utcnow)
    trigger_reason: str = Field(default="signal_change", max_length=120)

    @field_validator("user_id_hash", mode="before")
    @classmethod
    def _sanitize_user_hash(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), 120)
        if not cleaned:
            raise ValueError("user_id_hash cannot be empty")
        return cleaned

    @field_validator("tone_trajectory", "situational_portrait", "trigger_reason", mode="before")
    @classmethod
    def _sanitize_text_fields(cls, value: object) -> str:
        return sanitize_text(str(value or ""), 2_000)
