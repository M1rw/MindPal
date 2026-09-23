from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, ConfigDict, Field


class SafetyLevel(str, Enum):
    GENERAL_SUPPORT = "general_support"
    CRISIS = "crisis"
    HIGH_RISK = "high_risk"
    BLOCKED = "blocked"


class SafetyDecision(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    level: SafetyLevel = SafetyLevel.GENERAL_SUPPORT
    blocked: bool = False
    reason: str | None = None
    category: str = "general_support"
    matched_rules: list[str] = Field(default_factory=list)
