from __future__ import annotations

from dataclasses import dataclass

from backend.core.config import Settings, get_settings


@dataclass(frozen=True, slots=True)
class TTSServiceConfig:
    """Runtime configuration for text-to-speech provider orchestration."""

    max_tts_text_chars: int = 4_000
    max_voice_id_chars: int = 120
    max_provider_name_chars: int = 80
    default_timeout_seconds: float = 20.0
    require_external_provider: bool = False
    allow_browser_fallback_in_production: bool = True
    include_browser_fallback: bool = True

    @classmethod
    def from_settings(
        cls,
        settings: Settings | None = None,
        *,
        timeout_seconds: float | None = None,
        include_browser_fallback: bool | None = None,
        require_external_provider: bool | None = None,
        allow_browser_fallback_in_production: bool | None = None,
    ) -> "TTSServiceConfig":
        active_settings = settings or get_settings()

        return cls(
            default_timeout_seconds=float(
                timeout_seconds
                if timeout_seconds is not None
                else getattr(active_settings, "TTS_TIMEOUT_SECONDS", 20.0)
            ),
            include_browser_fallback=(
                bool(include_browser_fallback)
                if include_browser_fallback is not None
                else bool(getattr(active_settings, "ENABLE_BROWSER_TTS_FALLBACK", True))
            ),
            require_external_provider=(
                bool(require_external_provider)
                if require_external_provider is not None
                else bool(getattr(active_settings, "REQUIRE_EXTERNAL_TTS_PROVIDER", False))
            ),
            allow_browser_fallback_in_production=(
                bool(allow_browser_fallback_in_production)
                if allow_browser_fallback_in_production is not None
                else bool(getattr(active_settings, "ALLOW_BROWSER_TTS_IN_PRODUCTION", True))
            ),
        )
