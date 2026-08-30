from __future__ import annotations

from dataclasses import dataclass

from backend.core.config import Settings, get_settings


@dataclass(frozen=True, slots=True)
class SafetyServiceConfig:
    """Runtime configuration for local and LLM-assisted safety classification."""

    max_classification_text_chars: int = 8_000
    max_memory_context_chars: int = 1_200
    max_llm_json_chars: int = 6_000
    enable_llm_ambiguity_classifier: bool = True
    allow_offline_llm_classifier: bool = False

    @classmethod
    def from_settings(
        cls,
        settings: Settings | None = None,
        *,
        enable_llm_ambiguity_classifier: bool | None = None,
        allow_offline_llm_classifier: bool | None = None,
    ) -> "SafetyServiceConfig":
        active_settings = settings or get_settings()
        production_mode = getattr(active_settings, "ENVIRONMENT", "development").lower() == "production"

        return cls(
            enable_llm_ambiguity_classifier=(
                bool(enable_llm_ambiguity_classifier)
                if enable_llm_ambiguity_classifier is not None
                else bool(getattr(active_settings, "ENABLE_LLM_SAFETY_CLASSIFIER", True))
            ),
            allow_offline_llm_classifier=(
                bool(allow_offline_llm_classifier)
                if allow_offline_llm_classifier is not None
                else bool(getattr(active_settings, "ALLOW_OFFLINE_LLM_SAFETY_CLASSIFIER", not production_mode))
            ),
        )
