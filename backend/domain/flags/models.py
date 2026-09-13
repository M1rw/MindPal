# backend/domain/flags/models.py — Enterprise Feature Lifecycle Domain Models

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional, Set


class FeatureStage(str, Enum):
    """
    Tier-1 Feature Lifecycle Stages.
    Follows industry standard governance (Google Aubrey / Meta Gatekeeper / Statsig).
    """
    DARK_LAUNCH = "dark_launch"  # 0% public traffic; internal dogfood allowlist only
    CANARY = "canary"            # 1-25% canary rollout with telemetry gating
    BETA = "beta"                # 25-75% graduated rollout
    GA = "general_availability"  # 100% rollout; canonical platform behavior
    SUNSET = "sunset"            # Deprecated; forced false, awaiting code deletion SLA


class EvaluationReason(str, Enum):
    """Audit reason for feature evaluation."""
    ALLOWLIST_OVERRIDE = "allowlist_override"
    GA_ROLLOUT = "ga_rollout"
    PERCENTAGE_BUCKET = "percentage_bucket"
    DEFAULT_OFF = "default_off"
    SUNSET_DEPRECATED = "sunset_deprecated"


@dataclass(frozen=True)
class FeatureDefinition:
    """
    Formal specification for a capability toggle.
    Enforces semantic domain taxonomy and sunset governance.
    """
    key: str
    stage: FeatureStage
    rollout_percentage: int = 100
    owner: str = "core-platform"
    description: str = ""
    sunset_date: Optional[str] = None  # ISO date string (YYYY-MM-DD) for deprecation SLA
    allowlist: Set[str] = field(default_factory=set)

    def __post_init__(self) -> None:
        if not (0 <= self.rollout_percentage <= 100):
            raise ValueError(f"Rollout percentage must be 0-100, got {self.rollout_percentage}")


@dataclass(frozen=True)
class FlagEvaluation:
    """The result of evaluating a single feature flag for a user."""
    key: str
    enabled: bool
    stage: FeatureStage
    reason: EvaluationReason
    bucket: Optional[int] = None
