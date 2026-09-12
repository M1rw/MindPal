# backend/features/safety/schemas.py

"""
Safety levels, actions, decision contracts, and output guard schemas.
"""

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.core.security import Locale, normalize_locale, sanitize_text


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
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    rule_id: str = Field(min_length=1, max_length=120)
    source: SafetySource = SafetySource.LOCAL_REGEX
    language: Locale = "auto"
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    matched_text_hash: str | None = Field(default=None, max_length=120)
    metadata: dict[str, str | int | float | bool | None] = Field(default_factory=dict)


class SafetyDecision(BaseModel):
    model_config = ConfigDict(frozen=True, str_strip_whitespace=True, extra="forbid")

    level: SafetyLevel = SafetyLevel.SAFE
    bypass_llm: bool = False
    response_template_id: str | None = Field(default=None, min_length=1, max_length=120)
    matched_rules: list[str] = Field(default_factory=list)
    should_log: bool = False
    user_visible_category: str = Field(default="general_support", min_length=1, max_length=80)
    action: SafetyAction = SafetyAction.CONTINUE_TO_LLM
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    rationale: str | None = Field(default=None, max_length=300)

    @classmethod
    def safe(cls) -> SafetyDecision:
        return cls(level=SafetyLevel.SAFE, bypass_llm=False, action=SafetyAction.CONTINUE_TO_LLM)


class CrisisResponseTemplate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    template_id: str
    locale: str
    message: str
    helplines: list[dict[str, str]] = Field(default_factory=list)


class OutputGuardDecision(BaseModel):
    model_config = ConfigDict(frozen=True, str_strip_whitespace=True, extra="forbid")

    safe: bool = True
    rewritten_text: str | None = None
    violations: list[str] = Field(default_factory=list)
    contains_diagnostic_claim: bool = False
    contains_medication_advice: bool = False
    contains_therapist_assertion: bool = False
    pii_redacted: bool = False
