from __future__ import annotations

from backend.services.voice_feature_flags import (
    FEATURE_NAMES,
    VoiceV3FeatureName,
    VoiceV3FlagContext,
    evaluate_voice_v3_flags,
)

VoiceFlagContext = VoiceV3FlagContext
evaluate_voice_flags = evaluate_voice_v3_flags

__all__ = [
    "FEATURE_NAMES",
    "VoiceV3FeatureName",
    "VoiceV3FlagContext",
    "VoiceFlagContext",
    "evaluate_voice_v3_flags",
    "evaluate_voice_flags",
]
