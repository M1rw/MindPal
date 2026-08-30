from __future__ import annotations

from dataclasses import dataclass

from backend.core.config import Settings, get_settings


@dataclass(frozen=True, slots=True)
class OutputGuardServiceConfig:
    """Runtime configuration for output safety validation and rewriting."""

    max_output_text_chars: int = 12_000
    max_fallback_text_chars: int = 1_500
    max_rewrite_input_chars: int = 4_000
    max_rewrite_output_chars: int = 2_000
    default_action: str = "safe_rewrite"
    enable_llm_rewrite: bool = True
    allow_offline_llm_rewrite: bool = False

    @classmethod
    def from_settings(
        cls,
        settings: Settings | None = None,
        *,
        enable_llm_rewrite: bool | None = None,
        allow_offline_llm_rewrite: bool | None = None,
    ) -> "OutputGuardServiceConfig":
        active_settings = settings or get_settings()
        production_mode = getattr(active_settings, "ENVIRONMENT", "development").lower() == "production"

        return cls(
            enable_llm_rewrite=(
                bool(enable_llm_rewrite)
                if enable_llm_rewrite is not None
                else bool(getattr(active_settings, "ENABLE_LLM_OUTPUT_REWRITE", True))
            ),
            allow_offline_llm_rewrite=(
                bool(allow_offline_llm_rewrite)
                if allow_offline_llm_rewrite is not None
                else bool(getattr(active_settings, "ALLOW_OFFLINE_LLM_OUTPUT_REWRITE", not production_mode))
            ),
        )
