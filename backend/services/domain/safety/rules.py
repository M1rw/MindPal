# backend/services/domain/safety/rules.py

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from re import Pattern

from backend.core.security import Locale
from backend.models.safety import SafetyAction, SafetyLevel


class RuleMatchMode(StrEnum):
    """Rule pattern matching strategy mode."""

    ANY = "any"
    ALL = "all"
    PATTERN_GROUP = "pattern_group"


@dataclass(frozen=True, slots=True)
class CompiledSafetyRule:
    """Compiled safety rule containing regex patterns and action metadata."""

    rule_id: str
    level: SafetyLevel
    action: SafetyAction
    bypass_llm: bool
    response_template_id: str | None
    should_log: bool
    user_visible_category: str
    confidence: float
    priority: int
    match_mode: str
    source_locale: Locale
    patterns: tuple[Pattern[str], ...]
    pattern_groups: dict[str, tuple[Pattern[str], ...]]
    rag_tags: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class CompiledExclusionRule:
    """Exclusion rule used to filter false-positive safety matches."""

    rule_id: str
    description: str
    source_locale: Locale
    patterns: tuple[Pattern[str], ...]


@dataclass(frozen=True, slots=True)
class SafetyRuleMatch:
    """Result container for a matched safety rule during classification."""

    rule: CompiledSafetyRule
    confidence: float
    matched_pattern_refs: tuple[str, ...]
    exclusion_context: bool = False

    @property
    def priority(self) -> int:
        """Priority score derived from underlying rule."""
        return self.rule.priority


@dataclass(frozen=True, slots=True)
class SafetyClassifierMeta:
    """Execution telemetry for safety classification operations."""

    mode: str
    used_llm: bool
    fallback_used: bool
    provider_used: str | None = None
    error_code: str | None = None
