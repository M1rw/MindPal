# backend/features/safety/pattern_matcher.py

"""
Deterministic local regex and pattern matching engine for crisis detection.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from re import Pattern
import re
from typing import Any

import yaml

from backend.core.security import Locale, sanitize_text
from .schemas import SafetyAction, SafetyDecision, SafetyLevel

logger = logging.getLogger(__name__)
DEFAULT_SAFETY_DIR = Path(__file__).resolve().parents[2] / "safety"


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
    rag_tags: tuple[str, ...] = ()


def load_safety_rules(safety_dir: Path | None = None) -> list[CompiledSafetyRule]:
    directory = safety_dir or DEFAULT_SAFETY_DIR
    rules: list[CompiledSafetyRule] = []
    if not directory.exists():
        return rules

    for filename, locale in (("crisis_patterns_en.yaml", "en"), ("crisis_patterns_ar.yaml", "ar")):
        filepath = directory / filename
        if not filepath.exists():
            continue
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f)
            if isinstance(data, dict):
                for rule_dict in data.get("rules", []):
                    compiled = _compile_rule(rule_dict, locale=locale)
                    if compiled:
                        rules.append(compiled)
        except Exception as exc:
            logger.warning("safety_rules_load_failed file=%s error=%s", filename, type(exc).__name__)

    rules.sort(key=lambda r: r.priority, reverse=True)
    return rules


def _compile_rule(data: dict[str, Any], *, locale: Locale) -> CompiledSafetyRule | None:
    rule_id = sanitize_text(str(data.get("rule_id") or ""), 120)
    if not rule_id:
        return None

    level_str = str(data.get("level", "safe")).lower()
    level = SafetyLevel(level_str) if level_str in SafetyLevel._value2member_map_ else SafetyLevel.SAFE
    action_str = str(data.get("action", "continue_to_llm")).lower()
    action = SafetyAction(action_str) if action_str in SafetyAction._value2member_map_ else SafetyAction.CONTINUE_TO_LLM

    patterns: list[Pattern[str]] = []
    for pat in data.get("patterns", []):
        try:
            patterns.append(re.compile(str(pat), re.IGNORECASE | re.UNICODE))
        except re.error:
            pass

    return CompiledSafetyRule(
        rule_id=rule_id,
        level=level,
        action=action,
        bypass_llm=bool(data.get("bypass_llm", False)),
        response_template_id=data.get("response_template_id"),
        should_log=bool(data.get("should_log", False)),
        user_visible_category=str(data.get("user_visible_category", "general_support")),
        confidence=float(data.get("confidence", 1.0)),
        priority=int(data.get("priority", 0)),
        match_mode=str(data.get("match_mode", "any")),
        source_locale=locale,
        patterns=tuple(patterns),
        rag_tags=tuple(data.get("rag_tags", ())),
    )
