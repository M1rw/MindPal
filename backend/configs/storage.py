from __future__ import annotations

from .settings import get_settings

DEFAULT_STORAGE_PROVIDER = "supabase"


def configured_storage_provider() -> str:
    return get_settings().configured_storage_provider()


def supabase_settings() -> tuple[str, str]:
    return get_settings().supabase_settings()
