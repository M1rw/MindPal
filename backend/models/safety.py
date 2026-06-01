# backend/models/safety.py

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from backend.core.security import Locale, normalize_locale, safe_truncate, sanitize_text


class SafetyLevel(str, Enum):
    SAFE = "safe"
    SUPPORTIVE = "supportive"
    SELF_HARM_AMBIGUOUS = "self_harm_ambiguous"
    SELF_HARM_IMMINENT = "self_harm_imminent"
    ABUSE_OR_VIOLENCE = "abuse_or_violence"
    TOXICITY = "toxicity"


class SafetyAction(str, Enum):
    CONTINUE_TO_LLM = "continue_to_llm"
    DETERMINISTIC_RESPONSE = "deterministic_response"
    DEESCALATE = "deescalate"
    BLOCK = "block"


class SafetySource(str, Enum):
    LOCAL_REGEX = "local_regex"
    PERSPECTIVE_API = "perspective_api"
    OUTPUT_GUARD = "output_guard"
    POLICY = "policy"
    MANUAL = "manual"
    UNKNOWN = "unknown"


class SafetyMatchedRule(BaseModel):
    """
    Sanitized metadata for a matched safety rule.

    Never store raw user text here. matched_text_hash can be used later if we
    need deduplication without preserving sensitive content.
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    rule_id: str = Field(min_length=1, max_length=120)
    source: SafetySource = SafetySource.LOCAL_REGEX
    language: Locale = "auto"
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    matched_text_hash: str | None = Field(default=None, max_length=120)
    metadata: dict[str, str | int | float | bool | None] = Field(default_factory=dict)

    @field_validator("language", mode="before")
    @classmethod
    def _normalize_language(cls, value: object) -> Locale:
        return normalize_locale(str(value)) if value is not None else "auto"


class SafetyDecision(BaseModel):
    """
    Deterministic safety decision returned before any LLM call.

    The chat pipeline must enforce:
    - bypass_llm=True returns a deterministic template and must not call an LLM.
    - self_harm_imminent always bypasses the LLM.
    - safe decisions cannot point to emergency templates.
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    level: SafetyLevel = SafetyLevel.SAFE
    bypass_llm: bool = False
    response_template_id: str | None = Field(default=None, min_length=1, max_length=120)
    matched_rules: list[str] = Field(default_factory=list)
    should_log: bool = False
    user_visible_category: str = Field(default="general_support", min_length=1, max_length=80)
    action: SafetyAction = SafetyAction.CONTINUE_TO_LLM
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    rationale: str | None = Field(default=None, max_length=300)

    @field_validator("matched_rules")
    @classmethod
    def _clean_matched_rules(cls, value: list[str]) -> list[str]:
        seen: set[str] = set()
        cleaned: list[str] = []

        for item in value:
            rule_id = sanitize_text(str(item), 120)
            if not rule_id or rule_id in seen:
                continue
            seen.add(rule_id)
            cleaned.append(rule_id)

        return cleaned[:50]

    @field_validator("user_visible_category", "rationale", mode="before")
    @classmethod
    def _sanitize_short_text(cls, value: object) -> object:
        if value is None:
            return None
        return sanitize_text(str(value), 300)

    @model_validator(mode="after")
    def _validate_decision_consistency(self) -> SafetyDecision:
        if self.level == SafetyLevel.SAFE:
            if self.bypass_llm:
                raise ValueError("safe decisions cannot bypass the LLM")
            if self.response_template_id is not None:
                raise ValueError("safe decisions cannot set response_template_id")

        if self.level == SafetyLevel.SELF_HARM_IMMINENT:
            if not self.bypass_llm:
                raise ValueError("self_harm_imminent must bypass the LLM")
            if not self.response_template_id:
                raise ValueError("self_harm_imminent requires response_template_id")
            if self.action != SafetyAction.DETERMINISTIC_RESPONSE:
                raise ValueError("self_harm_imminent must use deterministic_response action")
            if not self.should_log:
                raise ValueError("self_harm_imminent must be logged as sanitized safety metadata")

        if self.bypass_llm:
            if not self.response_template_id:
                raise ValueError("bypass_llm requires response_template_id")
            if self.action == SafetyAction.CONTINUE_TO_LLM:
                raise ValueError("bypass_llm cannot use continue_to_llm action")

        return self

    @classmethod
    def safe(cls) -> SafetyDecision:
        return cls(
            level=SafetyLevel.SAFE,
            bypass_llm=False,
            matched_rules=[],
            should_log=False,
            user_visible_category="general_support",
            action=SafetyAction.CONTINUE_TO_LLM,
            confidence=0.0,
        )

    @classmethod
    def supportive(
        cls,
        *,
        matched_rules: list[str] | None = None,
        confidence: float = 0.4,
        category: str = "emotional_support",
    ) -> SafetyDecision:
        return cls(
            level=SafetyLevel.SUPPORTIVE,
            bypass_llm=False,
            matched_rules=matched_rules or [],
            should_log=False,
            user_visible_category=category,
            action=SafetyAction.CONTINUE_TO_LLM,
            confidence=confidence,
        )

    @classmethod
    def imminent_self_harm(
        cls,
        *,
        response_template_id: str,
        matched_rules: list[str],
        confidence: float = 1.0,
    ) -> SafetyDecision:
        return cls(
            level=SafetyLevel.SELF_HARM_IMMINENT,
            bypass_llm=True,
            response_template_id=response_template_id,
            matched_rules=matched_rules,
            should_log=True,
            user_visible_category="immediate_safety",
            action=SafetyAction.DETERMINISTIC_RESPONSE,
            confidence=confidence,
        )

    def to_public_dict(self) -> dict[str, Any]:
        """
        Public-safe shape suitable for API responses.
        """
        return {
            "level": self.level.value,
            "bypass_llm": self.bypass_llm,
            "matched_rules": self.matched_rules,
            "user_visible_category": self.user_visible_category,
        }


class SafetyEvent(BaseModel):
    """
    Sanitized event stored for audit/observability.

    raw_text is intentionally absent.
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    request_id: str = Field(min_length=1, max_length=80)
    user_id_hash: str = Field(min_length=1, max_length=80)
    decision: SafetyDecision
    source: SafetySource = SafetySource.LOCAL_REGEX
    locale: Locale = "auto"
    rule_matches: list[SafetyMatchedRule] = Field(default_factory=list)

    @field_validator("locale", mode="before")
    @classmethod
    def _normalize_locale(cls, value: object) -> Locale:
        return normalize_locale(str(value)) if value is not None else "auto"


class CrisisResponseTemplate(BaseModel):
    """
    Deterministic response template loaded from safety/crisis_responses.yaml.
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    template_id: str = Field(min_length=1, max_length=120)
    title: str = Field(min_length=1, max_length=160)
    locale: Locale = "auto"
    body: str = Field(min_length=1, max_length=2_000)
    priority: int = Field(default=100, ge=0, le=1_000)

    @field_validator("locale", mode="before")
    @classmethod
    def _normalize_template_locale(cls, value: object) -> Locale:
        return normalize_locale(str(value)) if value is not None else "auto"

    @field_validator("body")
    @classmethod
    def _clean_body(cls, value: str) -> str:
        return safe_truncate(sanitize_text(value, 2_000), 2_000)