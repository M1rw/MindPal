# backend/features/voice/schemas.py

"""
Voice V4 and Text-to-Speech contracts, schemas, and release decisions.
"""

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

VOICE_V4_FEATURE_KEY = "voice.live_v4"
VOICE_V4_CONTRACT_VERSION = 1
VOICE_V4_MODEL = "models/gemini-3.1-flash-live-preview"
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
    model: Literal["models/gemini-3.1-flash-live-preview"] = VOICE_V4_MODEL
    response_modality: Literal["AUDIO"] = "AUDIO"
    input_audio: VoiceV4PcmContract = VoiceV4PcmContract(encoding="PCM16LE", sample_rate_hz=16_000, channels=1)
    output_audio: VoiceV4PcmContract = VoiceV4PcmContract(encoding="PCM16LE", sample_rate_hz=24_000, channels=1)
    baseline: VoiceV4BaselineContract = VoiceV4BaselineContract()


VOICE_V4_CONTRACT = VoiceV4Contract()


class VoiceV4ReleaseDecision(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    feature_key: Literal["voice.live_v4"] = VOICE_V4_FEATURE_KEY
    environment: VoiceV4Environment
    allowed: bool
    reason: VoiceV4ReleaseReason
    contract_version: int = VOICE_V4_CONTRACT_VERSION


class TTSRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    text: str = Field(min_length=1, max_length=2_000)
    voice_id: str | None = Field(default=None, max_length=80)
    locale: str = Field(default="auto", max_length=20)


class TTSResponse(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    audio_base64: str = ""
    content_type: str = "audio/wav"
    duration_seconds: float = 0.0
    provider: str = "camb"
    cached: bool = False
