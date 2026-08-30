from __future__ import annotations

from dataclasses import dataclass

from backend.core.config import Settings, get_settings


@dataclass(frozen=True, slots=True)
class MemoryServiceConfig:
    """Runtime configuration for memory summarization and extraction."""

    summary_max_chars: int = 4_000
    max_compacted_summary_chars: int = 4_000
    max_extracted_item_text_chars: int = 500
    max_items_per_compaction: int = 20
    max_list_field_items: int = 80
    min_interactions_for_auto_compaction: int = 4
    max_llm_interaction_chars: int = 1_200
    max_llm_interactions: int = 24
    max_llm_json_chars: int = 12_000
    enable_llm_summarization: bool = True
    allow_offline_llm_summarization: bool = False

    @classmethod
    def from_settings(
        cls,
        settings: Settings | None = None,
        *,
        enable_llm_summarization: bool | None = None,
        allow_offline_llm_summarization: bool | None = None,
    ) -> "MemoryServiceConfig":
        active_settings = settings or get_settings()
        production_mode = getattr(active_settings, "ENVIRONMENT", "development").lower() == "production"

        return cls(
            summary_max_chars=int(getattr(active_settings, "MEMORY_SUMMARY_MAX_CHARS", 4_000)),
            max_compacted_summary_chars=int(getattr(active_settings, "MEMORY_SUMMARY_MAX_CHARS", 4_000)),
            enable_llm_summarization=(
                bool(enable_llm_summarization)
                if enable_llm_summarization is not None
                else bool(getattr(active_settings, "ENABLE_LLM_MEMORY_SUMMARIZATION", True))
            ),
            allow_offline_llm_summarization=(
                bool(allow_offline_llm_summarization)
                if allow_offline_llm_summarization is not None
                else bool(getattr(active_settings, "ALLOW_OFFLINE_LLM_MEMORY_SUMMARIZATION", not production_mode))
            ),
        )
