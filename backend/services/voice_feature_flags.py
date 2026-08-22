from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Literal

from backend.core.config import Settings

VoiceV3FeatureName = Literal[
    "VOICE_V3_ENABLED",
    "VOICE_V3_VERBAL_CUES_ENABLED",
    "VOICE_V3_PROSODY_CONTEXT_ENABLED",
    "VOICE_V3_MEMORY_ENABLED",
    "VOICE_V3_CLARIFICATION_ENABLED",
]

FEATURE_NAMES: tuple[VoiceV3FeatureName, ...] = (
    "VOICE_V3_ENABLED",
    "VOICE_V3_VERBAL_CUES_ENABLED",
    "VOICE_V3_PROSODY_CONTEXT_ENABLED",
    "VOICE_V3_MEMORY_ENABLED",
    "VOICE_V3_CLARIFICATION_ENABLED",
)


@dataclass(frozen=True, slots=True)
class VoiceV3FlagContext:
    environment: str
    user_key: str | None = None
    session_key: str | None = None
    overrides: dict[str, bool] | None = None
    user_overrides: dict[str, bool] | None = None
    session_overrides: dict[str, bool] | None = None


def evaluate_voice_v3_flags(settings: Settings, context: VoiceV3FlagContext) -> dict[str, bool]:
    """Evaluate flags without changing the legacy V2 route.

    Rollout is deterministic per user/session. Explicit session overrides have
    highest precedence, then user overrides, then environment settings.
    """
    values = {
        name: bool(getattr(settings, name, False if name == "VOICE_V3_ENABLED" else True))
        for name in FEATURE_NAMES
    }
    if values["VOICE_V3_ENABLED"]:
        rollout = int(getattr(settings, "VOICE_V3_ROLLOUT_PERCENT", 0))
        subject = context.session_key or context.user_key or "anonymous"
        values["VOICE_V3_ENABLED"] = rollout >= 100 or (rollout > 0 and _bucket(subject) < rollout)
    for name, value in (context.overrides or {}).items():
        if name in values:
            values[name] = bool(value)
    for name, value in (context.user_overrides or {}).items():
        if context.user_key and name in values:
            values[name] = bool(value)
    for name, value in (context.session_overrides or {}).items():
        if context.session_key and name in values:
            values[name] = bool(value)
    if not values["VOICE_V3_ENABLED"]:
        values["VOICE_V3_VERBAL_CUES_ENABLED"] = False
        values["VOICE_V3_PROSODY_CONTEXT_ENABLED"] = False
    return values


def _bucket(subject: str) -> int:
    digest = hashlib.sha256(subject.encode("utf-8", "ignore")).digest()
    return int.from_bytes(digest[:4], "big") % 100
