from __future__ import annotations

from backend.services.voice_launch_gate import (
    GEMINI_NATIVE_VOICE_NAMES,
    VoiceV3LaunchValidation,
    validate_production_voice_configuration,
)

VoiceLaunchValidation = VoiceV3LaunchValidation

__all__ = [
    "GEMINI_NATIVE_VOICE_NAMES",
    "VoiceV3LaunchValidation",
    "VoiceLaunchValidation",
    "validate_production_voice_configuration",
]
