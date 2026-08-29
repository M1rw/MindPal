"""Pure Voice V4 Layer 0 contracts and release controls.

This module deliberately has no FastAPI, database, provider, browser, audio,
WebSocket, or microphone dependencies. It defines only the boundary that later
Voice V4 layers must satisfy.
"""

from __future__ import annotations

from collections.abc import Mapping
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.models.feature_flags import FeatureEvaluation


VOICE_V4_FEATURE_KEY = "voice.live_v4"
VOICE_V4_CONTRACT_VERSION = 1
VOICE_V4_MODEL = "models/gemini-2.5-flash-native-audio-latest"
VOICE_V4_PROTOCOL_VERSION = "v1beta"


class VoiceV4Environment(str, Enum):
    DEVELOPMENT = "development"
    PREVIEW = "preview"
    STAGING = "staging"
    PRODUCTION = "production"


class VoiceV4ReleaseReason(str, Enum):
    ENABLED = "enabled"
    FEATURE_MISSING = "feature_missing"
    WRONG_FEATURE = "wrong_feature"
    FEATURE_DISABLED = "feature_disabled"
    FEATURE_LIFECYCLE_BLOCKED = "feature_lifecycle_blocked"
    APPROVAL_REQUIRED = "approval_required"
    PRODUCTION_GUARD = "production_guard"
    INVALID_ENVIRONMENT = "invalid_environment"


class VoiceV4PcmContract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    encoding: Literal["PCM16LE"]
    sample_rate_hz: Literal[16_000, 24_000]
    channels: Literal[1]


class VoiceV4BaselineContract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    audio_only: Literal[True] = True
    automatic_vad: Literal[True] = True
    fixed_system_instruction: Literal[True] = True
    one_voice: Literal[True] = True
    tools: Literal[False] = False
    memory: Literal[False] = False
    reconnect: Literal[False] = False
    session_resumption: Literal[False] = False
    dynamic_affect: Literal[False] = False


class VoiceV4Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    contract_version: int = Field(default=VOICE_V4_CONTRACT_VERSION, ge=1)
    feature_key: Literal["voice.live_v4"] = VOICE_V4_FEATURE_KEY
    transport: Literal["direct_browser_google_wss"] = "direct_browser_google_wss"
    provider_protocol: Literal["v1beta"] = VOICE_V4_PROTOCOL_VERSION
    model: Literal["models/gemini-2.5-flash-native-audio-latest"] = VOICE_V4_MODEL
    response_modality: Literal["AUDIO"] = "AUDIO"
    input_audio: VoiceV4PcmContract = VoiceV4PcmContract(
        encoding="PCM16LE", sample_rate_hz=16_000, channels=1
    )
    output_audio: VoiceV4PcmContract = VoiceV4PcmContract(
        encoding="PCM16LE", sample_rate_hz=24_000, channels=1
    )
    baseline: VoiceV4BaselineContract = VoiceV4BaselineContract()


VOICE_V4_CONTRACT = VoiceV4Contract()


class VoiceV4ReleaseDecision(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    feature_key: Literal["voice.live_v4"] = VOICE_V4_FEATURE_KEY
    environment: VoiceV4Environment
    allowed: bool
    reason: VoiceV4ReleaseReason
    contract_version: int = VOICE_V4_CONTRACT_VERSION


def evaluate_voice_v4_release(
    feature: FeatureEvaluation | None,
    *,
    environment: str,
    explicit_approval: bool,
) -> VoiceV4ReleaseDecision:
    """Return a fail-closed Layer 0 release decision.

    Production is authorized only when the authenticated request has already
    passed feature-policy evaluation and the deployment-owned explicit
    approval flag is enabled. The account policy remains the authority for
    which user can reach this decision.
    """

    try:
        target_environment = VoiceV4Environment(str(environment).strip().lower())
    except ValueError:
        return VoiceV4ReleaseDecision(
            environment=VoiceV4Environment.PRODUCTION,
            allowed=False,
            reason=VoiceV4ReleaseReason.INVALID_ENVIRONMENT,
        )

    if feature is None:
        return VoiceV4ReleaseDecision(
            environment=target_environment,
            allowed=False,
            reason=VoiceV4ReleaseReason.FEATURE_MISSING,
        )
    if feature.key != VOICE_V4_FEATURE_KEY:
        return VoiceV4ReleaseDecision(
            environment=target_environment,
            allowed=False,
            reason=VoiceV4ReleaseReason.WRONG_FEATURE,
        )
    if not feature.enabled:
        return VoiceV4ReleaseDecision(
            environment=target_environment,
            allowed=False,
            reason=VoiceV4ReleaseReason.FEATURE_DISABLED,
        )
    if feature.lifecycle.value in {"maintenance", "disabled", "deprecated"}:
        return VoiceV4ReleaseDecision(
            environment=target_environment,
            allowed=False,
            reason=VoiceV4ReleaseReason.FEATURE_LIFECYCLE_BLOCKED,
        )
    if not explicit_approval:
        return VoiceV4ReleaseDecision(
            environment=target_environment,
            allowed=False,
            reason=VoiceV4ReleaseReason.APPROVAL_REQUIRED,
        )
    return VoiceV4ReleaseDecision(
        environment=target_environment,
        allowed=True,
        reason=VoiceV4ReleaseReason.ENABLED,
    )


VOICE_DIAGNOSTIC_EVENTS = frozenset(
    {
        "session_created",
        "token_requested",
        "socket_open",
        "setup_sent",
        "setup_complete",
        "server_content",
        "input_transcription",
        "output_transcription",
        "generation_complete",
        "turn_complete",
        "interrupted",
        "playback_snapshot",
        "playback_drained",
        "go_away",
        "session_stopped",
        "error",
        "unknown",
    }
)
VOICE_DIAGNOSTIC_STATES = frozenset(
    {
        "IDLE",
        "REQUESTING_TOKEN",
        "CONNECTING",
        "SETUP_WAIT",
        "LISTENING",
        "USER_SPEAKING",
        "ASSISTANT_SPEAKING",
        "INTERRUPTED",
        "STOPPING",
        "ERROR",
    }
)
VOICE_DIAGNOSTIC_AUDIO_CONTEXT_STATES = frozenset({"suspended", "running", "closed", "interrupted", "unknown"})
VOICE_DIAGNOSTIC_MESSAGE_CATEGORIES = frozenset(
    {
        "setup_complete",
        "server_content",
        "tool_call",
        "tool_call_cancellation",
        "go_away",
        "session_resumption_update",
        "usage_metadata",
        "unknown",
    }
)


class SafeVoiceDiagnostic(BaseModel):
    """Allow-listed diagnostic facts; no arbitrary payload is accepted."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    session_id: str | None = Field(default=None, min_length=8, max_length=80, pattern=r"^vs_[A-Za-z0-9_-]+$")
    event: str = Field(default="unknown", min_length=1, max_length=40)
    state: str | None = Field(default=None, max_length=32)
    generation: int | None = Field(default=None, ge=0, le=2_000_000_000)
    playback_epoch: int | None = Field(default=None, ge=0, le=2_000_000_000)
    audio_context_state: str | None = Field(default=None, max_length=16)
    capture_frames: int | None = Field(default=None, ge=0, le=10_000_000)
    sent_frames: int | None = Field(default=None, ge=0, le=10_000_000)
    received_audio_parts: int | None = Field(default=None, ge=0, le=10_000_000)
    scheduled_chunks: int | None = Field(default=None, ge=0, le=10_000_000)
    drained_chunks: int | None = Field(default=None, ge=0, le=10_000_000)
    queue_depth_ms: int | None = Field(default=None, ge=0, le=86_400_000)
    active_sources: int | None = Field(default=None, ge=0, le=100_000)
    message_category: str | None = Field(default=None, max_length=40)
    error_code: str | None = Field(default=None, max_length=80, pattern=r"^[a-z0-9_]+$")

    @field_validator("event")
    @classmethod
    def _safe_event(cls, value: str) -> str:
        return value if value in VOICE_DIAGNOSTIC_EVENTS else "unknown"

    @field_validator("state")
    @classmethod
    def _safe_state(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value if value in VOICE_DIAGNOSTIC_STATES else None

    @field_validator("audio_context_state")
    @classmethod
    def _safe_audio_context_state(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value if value in VOICE_DIAGNOSTIC_AUDIO_CONTEXT_STATES else "unknown"

    @field_validator("message_category")
    @classmethod
    def _safe_message_category(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value if value in VOICE_DIAGNOSTIC_MESSAGE_CATEGORIES else "unknown"


def build_safe_voice_diagnostic(payload: Mapping[str, Any] | None) -> dict[str, Any]:
    """Filter unknown/private fields and return JSON-safe diagnostic facts."""

    if not isinstance(payload, Mapping):
        return SafeVoiceDiagnostic().model_dump(exclude_none=True)

    allowed_fields = set(SafeVoiceDiagnostic.model_fields)
    filtered = {key: value for key, value in payload.items() if key in allowed_fields}
    try:
        return SafeVoiceDiagnostic.model_validate(filtered).model_dump(exclude_none=True)
    except Exception:
        return SafeVoiceDiagnostic(event="unknown").model_dump(exclude_none=True)
