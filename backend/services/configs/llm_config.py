from __future__ import annotations

from dataclasses import dataclass

from backend.core.config import Settings, get_settings


@dataclass(frozen=True, slots=True)
class LLMServiceConfig:
    """Runtime configuration for the provider-fallback LLM service."""

    timeout_seconds: float = 45.0
    require_remote_provider: bool = True
    allow_offline_in_production: bool = False
    include_offline_provider: bool = False
    max_provider_name_chars: int = 80
    max_provider_error_chars: int = 120
    max_offline_reply_chars: int = 1_500

    @classmethod
    def from_settings(
        cls,
        settings: Settings | None = None,
        *,
        timeout_seconds: float | None = None,
        require_remote_provider: bool | None = None,
        allow_offline_in_production: bool | None = None,
        include_offline_provider: bool | None = None,
    ) -> "LLMServiceConfig":
        active_settings = settings or get_settings()
        production_mode = getattr(active_settings, "ENVIRONMENT", "development").lower() == "production"

        return cls(
            timeout_seconds=float(
                timeout_seconds
                if timeout_seconds is not None
                else getattr(active_settings, "LLM_TIMEOUT_SECONDS", 45.0)
            ),
            require_remote_provider=(
                bool(require_remote_provider)
                if require_remote_provider is not None
                else bool(getattr(active_settings, "REQUIRE_REMOTE_LLM_PROVIDER", production_mode))
            ),
            allow_offline_in_production=(
                bool(allow_offline_in_production)
                if allow_offline_in_production is not None
                else bool(getattr(active_settings, "ALLOW_OFFLINE_LLM_IN_PRODUCTION", False))
            ),
            include_offline_provider=(
                bool(include_offline_provider)
                if include_offline_provider is not None
                else bool(getattr(active_settings, "ENABLE_OFFLINE_LLM_FALLBACK", not production_mode))
            ),
        )
