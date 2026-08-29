# backend/features/flags/schemas.py

"""
Feature-management domain types, schemas, and built-in MindPal registry.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from typing import FrozenSet

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

REGISTRY_VERSION = 1


class FeatureLifecycle(str, Enum):
    ACTIVE = "active"
    BETA = "beta"
    PREVIEW = "preview"
    MAINTENANCE = "maintenance"
    DISABLED = "disabled"
    DEPRECATED = "deprecated"


class FeatureReason(str, Enum):
    ENABLED = "enabled"
    ENABLED_FOR_ADMIN = "enabled_for_admin"
    UNKNOWN_FEATURE = "unknown_feature"
    DISABLED = "disabled"
    MAINTENANCE = "maintenance"
    PREVIEW_ONLY = "preview_only"
    NOT_IN_ROLLOUT = "not_in_rollout"
    REQUIRES_AUTHENTICATION = "requires_authentication"
    CHANNEL_NOT_ALLOWED = "channel_not_allowed"
    LOCALE_NOT_ALLOWED = "locale_not_allowed"
    NOT_STARTED = "not_started"
    EXPIRED = "expired"
    EXPLICIT_DENY = "explicit_deny"
    PREREQUISITE_DISABLED = "prerequisite_disabled"


@dataclass(frozen=True, slots=True)
class FeatureSpec:
    key: str
    title: str
    description: str
    lifecycle: FeatureLifecycle = FeatureLifecycle.ACTIVE
    user_visible: bool = True
    default_enabled: bool = True
    requires_authentication: bool = False
    override_database: bool = False
    user_toggleable: bool = True
    safety_critical: bool = False
    allow_admins: bool = True
    allowed_channels: FrozenSet[str] = field(default_factory=frozenset)
    allowed_locales: FrozenSet[str] = field(default_factory=frozenset)
    fallback_key: str | None = None
    replacement_key: str | None = None
    prerequisites: tuple[str, ...] = ()


class FeaturePolicy(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    key: str = Field(min_length=1, max_length=120, pattern=r"^[a-z0-9]+(?:[._-][a-z0-9]+)*$")
    version: int = Field(default=1, ge=1, le=2_000_000_000)
    lifecycle: FeatureLifecycle | None = None
    enabled: bool | None = None
    requires_authentication: bool | None = None
    allow_admins: bool | None = None
    allowed_channels: list[str] | None = Field(default=None, max_length=20)
    allowed_locales: list[str] | None = Field(default=None, max_length=30)
    rollout_percentage: int | None = Field(default=None, ge=0, le=100)
    allow_user_hashes: list[str] = Field(default_factory=list, max_length=1_000)
    deny_user_hashes: list[str] = Field(default_factory=list, max_length=1_000)
    prerequisites: list[str] | None = Field(default=None, max_length=20)
    starts_at_utc: datetime | None = None
    ends_at_utc: datetime | None = None
    fallback_key: str | None = Field(default=None, max_length=120)
    replacement_key: str | None = Field(default=None, max_length=120)

    @field_validator("allowed_channels", "allowed_locales", "prerequisites", mode="before")
    @classmethod
    def _clean_string_lists(cls, value: object) -> list[str] | None:
        if value is None:
            return None
        if not isinstance(value, (list, tuple, set, frozenset)):
            raise ValueError("must be a list of strings")
        return [str(item).strip().lower() for item in value if str(item).strip()]

    @field_validator("allow_user_hashes", "deny_user_hashes", mode="before")
    @classmethod
    def _clean_user_hashes(cls, value: object) -> list[str]:
        if value is None:
            return []
        if not isinstance(value, (list, tuple, set, frozenset)):
            raise ValueError("must be a list of strings")
        cleaned = [str(item).strip() for item in value if str(item).strip()]
        for item in cleaned:
            if not re.match(r"^usr_[a-f0-9]{16,64}$", item):
                raise ValueError("user hashes must match ^usr_[a-f0-9]{16,64}$")
        return cleaned

    @model_validator(mode="after")
    def _validate_lists_and_dates(self) -> FeaturePolicy:
        if self.starts_at_utc and self.starts_at_utc.tzinfo is None:
            raise ValueError("starts_at_utc must be timezone-aware")
        if self.ends_at_utc and self.ends_at_utc.tzinfo is None:
            raise ValueError("ends_at_utc must be timezone-aware")
        if self.starts_at_utc and self.ends_at_utc and self.starts_at_utc > self.ends_at_utc:
            raise ValueError("starts_at_utc cannot be after ends_at_utc")
        if set(self.allow_user_hashes) & set(self.deny_user_hashes):
            raise ValueError("allow_user_hashes and deny_user_hashes cannot overlap")
        return self


@dataclass(frozen=True, slots=True)
class FeatureContext:
    user_id_hash: str | None = None
    email_hash: str | None = None
    authenticated: bool = False
    is_admin: bool = False
    channel: str = "web"
    locale: str = "auto"
    now_utc: datetime = field(default_factory=lambda: datetime.now(UTC))


EvaluationContext = FeatureContext


@dataclass(frozen=True, slots=True)
class FeatureEvaluation:
    key: str
    title: str
    description: str
    lifecycle: FeatureLifecycle
    enabled: bool
    reason: FeatureReason
    user_visible: bool = True
    user_toggleable: bool = True
    safety_critical: bool = False
    fallback_key: str | None = None
    replacement_key: str | None = None
    version: int = REGISTRY_VERSION

    def to_public_dict(self) -> dict[str, object]:
        return {
            "key": self.key,
            "title": self.title,
            "description": self.description,
            "lifecycle": self.lifecycle.value if hasattr(self.lifecycle, "value") else str(self.lifecycle),
            "enabled": self.enabled,
            "reason": self.reason.value if hasattr(self.reason, "value") else str(self.reason),
            "user_visible": self.user_visible,
            "user_toggleable": self.user_toggleable,
            "safety_critical": self.safety_critical,
            "fallback_key": self.fallback_key,
            "replacement_key": self.replacement_key,
            "version": self.version,
        }


FeatureDecision = FeatureEvaluation


class FeatureEvaluationPublic(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    key: str
    title: str
    description: str
    enabled: bool
    lifecycle: FeatureLifecycle
    requires_authentication: bool = False
    user_toggleable: bool = True
    fallback_key: str | None = None
    replacement_key: str | None = None


FeaturePublicItem = FeatureEvaluationPublic


class FeaturePublicSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    features: list[FeatureEvaluationPublic]
    policy_version: int = 1


class FeatureAdminUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    policy: FeaturePolicy


FeatureAdminUpdate = FeatureAdminUpdateRequest
FeaturePolicyDocument = FeaturePolicy


FEATURE_REGISTRY: dict[str, FeatureSpec] = {
    "voice.live_v4": FeatureSpec(
        key="voice.live_v4",
        title="Live voice",
        description="Real-time full-duplex voice conversation.",
        lifecycle=FeatureLifecycle.ACTIVE,
        default_enabled=True,
        requires_authentication=False,
        fallback_key="chat.standard_model",
        replacement_key=None,
    ),
    "voice.v4": FeatureSpec(
        key="voice.v4",
        title="Voice V4 Preview",
        description="Real-time Gemini voice engine with zero client secrets.",
        lifecycle=FeatureLifecycle.PREVIEW,
        default_enabled=False,
        requires_authentication=True,
    ),
    "chat.standard_model": FeatureSpec(
        key="chat.standard_model",
        title="Standard chat",
        description="Core conversational model.",
        lifecycle=FeatureLifecycle.ACTIVE,
        default_enabled=True,
    ),
    "chat.pro_model": FeatureSpec(
        key="chat.pro_model",
        title="Clinical reasoning",
        description="Multi-step reasoning pipeline.",
        lifecycle=FeatureLifecycle.ACTIVE,
        default_enabled=True,
        requires_authentication=True,
    ),
    "chat.clinical_pro": FeatureSpec(
        key="chat.clinical_pro",
        title="Clinical Pro Mode",
        description="Full 6-step clinical reasoning protocol.",
        lifecycle=FeatureLifecycle.ACTIVE,
    ),
    "mental_health.insights": FeatureSpec(
        key="mental_health.insights",
        title="Mental health insights",
        description="Pattern detection across sessions.",
        lifecycle=FeatureLifecycle.PREVIEW,
        default_enabled=False,
    ),
    "security.crisis_interception": FeatureSpec(
        key="security.crisis_interception",
        title="Crisis interception",
        description="Deterministic crisis guardrails.",
        lifecycle=FeatureLifecycle.ACTIVE,
        safety_critical=True,
        user_toggleable=False,
        default_enabled=True,
    ),
    "tools.web_search": FeatureSpec(
        key="tools.web_search",
        title="Web Search",
        description="Real-time web queries via DuckDuckGo.",
        lifecycle=FeatureLifecycle.ACTIVE,
        requires_authentication=True,
    ),
    "tools.memory_search": FeatureSpec(
        key="tools.memory_search",
        title="Memory Search",
        description="Semantic memory search across user conversations.",
        lifecycle=FeatureLifecycle.ACTIVE,
        requires_authentication=True,
    ),
}

BUILTIN_FEATURES = FEATURE_REGISTRY


def get_feature_spec(key: str) -> FeatureSpec | None:
    return FEATURE_REGISTRY.get(key)


def get_all_feature_specs() -> list[FeatureSpec]:
    return list(FEATURE_REGISTRY.values())
