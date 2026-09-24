"""Centralized MindPal runtime configuration.

This package is the single home for defaults, environment keys, and feature-level
policy values that used to be spread across the backend by module.
"""

from .app import app_environment, is_production
from .auth import FIREBASE_ENV_KEYS, firebase_public_bootstrap
from .llm import (
    DEFAULT_GROQ_CHAT_MODEL,
    DEFAULT_GROQ_JSON_MODEL,
    DEFAULT_OPENROUTER_CHAT_MODEL,
    DEFAULT_OPENROUTER_JSON_MODEL,
    groq_api_key,
    groq_base_url,
    groq_chat_model,
    groq_json_model,
    openrouter_api_key,
    openrouter_base_url,
    openrouter_chat_model,
    openrouter_json_model,
)
from .storage import DEFAULT_STORAGE_PROVIDER, configured_storage_provider, supabase_settings
from .settings import Settings, get_settings, reset_settings_cache
from .voice import STAY_SUPPORT_NOTE, VOICE_CRISIS_SYSTEM, VOICE_SUMMARY_SYSTEM

__all__ = [
    "FIREBASE_ENV_KEYS",
    "DEFAULT_STORAGE_PROVIDER",
    "app_environment",
    "is_production",
    "firebase_public_bootstrap",
    "configured_storage_provider",
    "supabase_settings",
    "openrouter_api_key",
    "openrouter_base_url",
    "openrouter_chat_model",
    "openrouter_json_model",
    "groq_api_key",
    "groq_base_url",
    "groq_chat_model",
    "groq_json_model",
    "DEFAULT_OPENROUTER_CHAT_MODEL",
    "DEFAULT_OPENROUTER_JSON_MODEL",
    "DEFAULT_GROQ_CHAT_MODEL",
    "DEFAULT_GROQ_JSON_MODEL",
    "STAY_SUPPORT_NOTE",
    "VOICE_CRISIS_SYSTEM",
    "VOICE_SUMMARY_SYSTEM",
    "Settings",
    "get_settings",
    "reset_settings_cache",
]
