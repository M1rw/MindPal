# backend/services/domain/safety/rules.py

from __future__ import annotations

from dataclasses import dataclass
from re import Pattern

from backend.core.security import Locale
from backend.models.safety import SafetyAction, SafetyLevel


@dataclass(frozen=True, slots=True)
class CompiledSafetyRule:
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
    rule_id: str
    description: str
    source_locale: Locale
    patterns: tuple[Pattern[str], ...]


@dataclass(frozen=True, slots=True)
class SafetyRuleMatch:
    rule: CompiledSafetyRule
    confidence: float
    matched_pattern_refs: tuple[str, ...]
    exclusion_context: bool = False

    @property
    def priority(self) -> int:
        return self.rule.priority


@dataclass(frozen=True, slots=True)
class SafetyClassifierMeta:
    mode: str
    used_llm: bool
    fallback_used: bool
    provider_used: str | None = None
    error_code: str | None = None
