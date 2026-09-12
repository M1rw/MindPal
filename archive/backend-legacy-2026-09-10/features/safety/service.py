# backend/features/safety/service.py

"""
Real-time multi-lingual crisis and safety evaluation service.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from backend.core.config import Settings, get_settings
from backend.core.security import Locale, normalize_locale, sanitize_text
from .pattern_matcher import CompiledSafetyRule, load_safety_rules
from .schemas import CrisisResponseTemplate, SafetyAction, SafetyDecision, SafetyLevel

logger = logging.getLogger(__name__)

MAX_CLASSIFICATION_TEXT_CHARS = 8_000


class SafetyService:
    """Evaluates inbound user messages for crisis indicators and safety risks."""

    def __init__(
        self,
        *,
        rules: list[CompiledSafetyRule] | None = None,
        safety_dir: Path | None = None,
        settings: Settings | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self._rules: list[CompiledSafetyRule] = rules if rules is not None else load_safety_rules(safety_dir)

    def classify_message(
        self,
        text: str,
        *,
        locale: str = "auto",
    ) -> SafetyDecision:
        cleaned = sanitize_text(text, MAX_CLASSIFICATION_TEXT_CHARS).strip()
        if not cleaned:
            return SafetyDecision.safe()

        norm_locale = normalize_locale(locale)
        matched_rules: list[str] = []
        highest_rule: CompiledSafetyRule | None = None

        for rule in self._rules:
            if rule.source_locale != "auto" and norm_locale != "auto" and rule.source_locale != norm_locale:
                continue

            matches = any(pat.search(cleaned) for pat in rule.patterns)
            if matches:
                matched_rules.append(rule.rule_id)
                if highest_rule is None or rule.priority > highest_rule.priority:
                    highest_rule = rule

        if highest_rule is not None:
            return SafetyDecision(
                level=highest_rule.level,
                bypass_llm=highest_rule.bypass_llm,
                response_template_id=highest_rule.response_template_id,
                matched_rules=matched_rules,
                should_log=highest_rule.should_log,
                user_visible_category=highest_rule.user_visible_category,
                action=highest_rule.action,
                confidence=highest_rule.confidence,
                rationale=f"Matched {len(matched_rules)} local crisis rules",
            )

        return SafetyDecision.safe()
