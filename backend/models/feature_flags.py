"""Feature-management domain types and the built-in MindPal registry.

This module is intentionally free of FastAPI, database, browser, and provider
side effects. It defines the stable feature vocabulary used by the evaluator,
API, and frontend snapshot.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
import re
from typing import FrozenSet

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


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
    """Static metadata and safe defaults for one registered capability."""

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
    """Bounded server-owned policy overrides for a registered feature.

    This is a policy document, not a user preference. Raw identifiers are not
    accepted here; allow/deny entries must already be one-way user hashes.
    """

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
        cleaned = [str(item).strip().lower() for item in value if str(item).strip()]
        if any(len(item) > 80 for item in cleaned):
            raise ValueError("list item is too long")
        return list(dict.fromkeys(cleaned))

    @field_validator("allow_user_hashes", "deny_user_hashes", mode="before")
    @classmethod
    def _clean_user_hashes(cls, value: object) -> list[str]:
        if value is None:
            return []
        if not isinstance(value, (list, tuple, set, frozenset)):
            raise ValueError("must be a list of user hashes")
        cleaned = [str(item).strip() for item in value if str(item).strip()]
        if any(len(item) > 120 for item in cleaned):
            raise ValueError("user hash is too long")
        if any(not re.fullmatch(r"usr_[0-9a-f]{32}", item) for item in cleaned):
            raise ValueError("target lists must contain server-generated user hashes")
        return list(dict.fromkeys(cleaned))

    @field_validator("starts_at_utc", "ends_at_utc", mode="before")
    @classmethod
    def _normalize_datetime(cls, value: object) -> datetime | None:
        if value is None:
            return None
        if isinstance(value, str):
            try:
                value = datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError as exc:
                raise ValueError("timestamps must be valid ISO datetime values") from exc
        if not isinstance(value, datetime):
            raise ValueError("timestamps must be datetime values")
        if value.tzinfo is None:
            raise ValueError("timestamps must be timezone-aware")
        return value.astimezone(UTC)

    @model_validator(mode="after")
    def _validate_window_and_lists(self) -> FeaturePolicy:
        if self.starts_at_utc is not None and self.ends_at_utc is not None:
            if self.ends_at_utc <= self.starts_at_utc:
                raise ValueError("ends_at_utc must be after starts_at_utc")
        if set(self.allow_user_hashes) & set(self.deny_user_hashes):
            raise ValueError("a user hash cannot be both allowed and denied")
        return self


@dataclass(frozen=True, slots=True)
class FeatureContext:
    """Trusted request facts used by the evaluator."""

    user_id_hash: str | None = None
    email_hash: str | None = None
    authenticated: bool = False
    is_admin: bool = False
    channel: str = "web"
    locale: str = "auto"
    now_utc: datetime = field(default_factory=lambda: datetime.now(UTC))

    def __post_init__(self) -> None:
        now = self.now_utc
        if now.tzinfo is None:
            raise ValueError("now_utc must be timezone-aware")
        object.__setattr__(self, "now_utc", now.astimezone(UTC))
        object.__setattr__(self, "channel", str(self.channel or "unknown").strip().lower())
        object.__setattr__(self, "locale", str(self.locale or "auto").strip().lower())
        if self.user_id_hash is not None:
            object.__setattr__(self, "user_id_hash", str(self.user_id_hash).strip() or None)
        if self.email_hash is not None:
            object.__setattr__(self, "email_hash", str(self.email_hash).strip() or None)


@dataclass(frozen=True, slots=True)
class FeatureEvaluation:
    key: str
    title: str
    description: str
    lifecycle: FeatureLifecycle
    enabled: bool
    reason: FeatureReason
    user_visible: bool
    user_toggleable: bool
    safety_critical: bool
    fallback_key: str | None = None
    replacement_key: str | None = None
    version: int = 1

    def to_public_dict(self) -> dict[str, object]:
        """Return the intentionally narrow browser/API representation."""
        return {
            "key": self.key,
            "title": self.title,
            "description": self.description,
            "lifecycle": self.lifecycle.value,
            "enabled": self.enabled,
            "reason": self.reason.value,
            "user_visible": self.user_visible,
            "user_toggleable": self.user_toggleable,
            "safety_critical": self.safety_critical,
            "fallback_key": self.fallback_key,
            "replacement_key": self.replacement_key,
            "version": self.version,
        }


FEATURE_REGISTRY: dict[str, FeatureSpec] = {
    "chat.standard_model": FeatureSpec(
        key="chat.standard_model",
        title="Standard chat",
        description="Fast, warm peer support for everyday conversations.",
    ),
    "chat.pro_model": FeatureSpec(
        key="chat.pro_model",
        title="Pro chat",
        description="Deeper reasoning and structured reflection tools.",
        requires_authentication=True,
        fallback_key="chat.standard_model",
    ),
    "chat.listening_styles": FeatureSpec(
        key="chat.listening_styles",
        title="Listening styles",
        description="Active Listen, Guided Coach, and Cognitive Tools modes.",
    ),
    "memory.local": FeatureSpec(
        key="memory.local",
        title="Local memory",
        description="Personal context stored on this device.",
        safety_critical=False,
    ),
    "memory.cloud_sync": FeatureSpec(
        key="memory.cloud_sync",
        title="Cloud sync",
        description="Sync memory and conversations across signed-in devices.",
        requires_authentication=True,
        fallback_key="memory.local",
    ),
    "mental_health.insights": FeatureSpec(
        key="mental_health.insights",
        title="Mental-health insights",
        description="Personal reflection summaries and screening history.",
        lifecycle=FeatureLifecycle.BETA,
        default_enabled=False,
        requires_authentication=True,
        fallback_key="chat.standard_model",
    ),
    "data.export": FeatureSpec(
        key="data.export",
        title="Conversation export",
        description="Download the current local conversation.",
    ),
    "data.product_improvement": FeatureSpec(
        key="data.product_improvement",
        title="Product improvement signals",
        description="Share anonymized product-quality signals.",
        lifecycle=FeatureLifecycle.PREVIEW,
        default_enabled=False,
        safety_critical=False,
    ),
    "notifications.response_complete": FeatureSpec(
        key="notifications.response_complete",
        title="Response-complete notifications",
        description="Notify you when a reply finishes in the background.",
        lifecycle=FeatureLifecycle.BETA,
        default_enabled=True,
    ),
    "notifications.streak_reminders": FeatureSpec(
        key="notifications.streak_reminders",
        title="Streak reminders",
        description="Gentle reminders when a reflection streak is at risk.",
        lifecycle=FeatureLifecycle.BETA,
        default_enabled=False,
    ),
    "notifications.mood_check_in": FeatureSpec(
        key="notifications.mood_check_in",
        title="Mood check-ins",
        description="An optional evening reflection prompt.",
        lifecycle=FeatureLifecycle.BETA,
        default_enabled=False,
    ),
    "security.crisis_interception": FeatureSpec(
        key="security.crisis_interception",
        title="Crisis interception",
        description="Deterministic local emergency-support handling.",
        safety_critical=True,
        user_toggleable=False,
    ),
    "brain.workspace": FeatureSpec(
        key="brain.workspace",
        title="Brain workspace",
        description="Explore and manage durable memory context.",
        lifecycle=FeatureLifecycle.BETA,
        default_enabled=True,
        requires_authentication=True,
        fallback_key="memory.local",
    ),
    "voice.live_v4": FeatureSpec(
        key="voice.live_v4",
        title="Live voice",
        description="Real-time full-duplex voice conversation.",
        lifecycle=FeatureLifecycle.ACTIVE,
        default_enabled=True,
        requires_authentication=False,
        override_database=True,
        user_toggleable=True,
        fallback_key="chat.standard_model",
    ),
}

REGISTRY_VERSION = 1


def get_feature_spec(key: str) -> FeatureSpec | None:
    return FEATURE_REGISTRY.get(str(key).strip().lower())
