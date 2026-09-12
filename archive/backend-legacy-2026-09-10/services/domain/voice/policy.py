# backend/services/domain/voice/policy.py

from __future__ import annotations

from dataclasses import dataclass
from backend.models.schemas import TTSFormat


@dataclass(frozen=True, slots=True)
class TTSPolicy:
    """TTS execution policy describing voice selection and fallback allowances."""

    locale: str
    voice_id: str | None
    speaking_rate: float
    format: TTSFormat
    browser_fallback_allowed: bool
    external_tts_allowed: bool
    reason: str


@dataclass(frozen=True, slots=True)
class TTSServiceMeta:
    """Execution telemetry for TTS generation requests."""

    mode: str
    provider_used: str
    fallback_used: bool
    external_attempted: bool
    error_code: str | None = None
