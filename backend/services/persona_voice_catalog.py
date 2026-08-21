from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from backend.core.config import Settings, get_settings
from backend.core.security import sanitize_text


@dataclass(frozen=True, slots=True)
class PersonaVoice:
    persona: str
    tts_provider: str
    voice_id: str | None
    gender: str
    style: str
    supports_emotion: bool = False


class PersonaVoiceCatalog:
    """Resolve Gemini persona names to explicit provider voice IDs.

    Missing IDs are intentional configuration failures. The catalog never falls
    back to a provider default because that could produce a mismatched verbal cue.
    """

    def __init__(self, voices: dict[str, PersonaVoice] | None = None, *, settings: Settings | None = None) -> None:
        if voices is not None:
            self._voices = {self._normalize_key(name): voice for name, voice in voices.items()}
        else:
            current = settings or get_settings()
            self._voices = {
                "kore": PersonaVoice("Kore", "camb", _clean_voice_id(getattr(current, "CAMB_KORE_VOICE_ID", None)), "female", "warm_natural"),
                "charon": PersonaVoice("Charon", "camb", _clean_voice_id(getattr(current, "CAMB_CHARON_VOICE_ID", None)), "male", "calm_deep"),
            }

    def resolve(self, persona: str) -> PersonaVoice | None:
        return self._voices.get(self._normalize_key(persona))

    def is_configured(self, persona: str) -> bool:
        voice = self.resolve(persona)
        return voice is not None and bool(voice.voice_id)

    def public_config(self) -> dict[str, Any]:
        return {
            "persona_voice_catalog": {
                voice.persona: {
                    "tts_provider": voice.tts_provider,
                    "voice_id": voice.voice_id or "REQUIRED",
                    "gender": voice.gender,
                    "style": voice.style,
                }
                for voice in self._voices.values()
            },
            "fallback_policy": "non_verbal_hum",
        }

    @staticmethod
    def _normalize_key(value: str) -> str:
        return sanitize_text(value, 120).strip().lower()


def _clean_voice_id(value: str | None) -> str | None:
    cleaned = sanitize_text(value or "", 120).strip()
    return cleaned or None
