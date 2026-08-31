# backend/core/__init__.py

"""
MindPal core infrastructure package.

This package contains pure framework-agnostic infrastructure foundations:
configuration management, settings validation, structured logging, safe text
and URL sanitization, database primitives, and core exception types.

Importing this package must not:
- load domain business logic
- load AI provider clients
- connect to external services
"""

from __future__ import annotations

from .config import Settings, get_settings, reset_settings
from .db import DatabaseEngine, DatabaseSession, get_db_session
from .errors import (
    AppError,
    AuthError,
    AuthServiceError,
    ConfigError,
    DatabaseError,
    DatabaseServiceError,
    InputTooLongError,
    LLMServiceError,
    MemoryAppError,
    MemoryServiceError,
    MindPalError,
    OutputGuardError,
    OutputGuardServiceError,
    PermissionDeniedError,
    ProviderError,
    ProviderTimeoutError,
    RAGError,
    RAGServiceError,
    RateLimitError,
    SafetyError,
    SafetyServiceError,
    SecurityError,
    SettingsError,
    TTSError,
    TTSServiceError,
    ValidationAppError,
)
from .logging import configure_logging, get_logger, log_event
from .middleware import RequestBodyLimitMiddleware
from .security import (
    Locale,
    generate_request_id,
    hash_user_id,
    normalize_locale,
    redact_basic_pii,
    safe_truncate,
    sanitize_text,
    strip_invisible_chars,
    validate_url,
)
from .settings_helpers import (
    parse_bool_setting,
    parse_float_setting,
    parse_int_setting,
    parse_json_setting,
    parse_string_list_setting,
)
from .url_validator import is_safe_url
from .validation import validate_email, validate_input_length


def __getattr__(name: str):
    """Lazy import domain components to avoid circular imports and keep core pure."""
    if name == "requires_verified_web_search":
        from backend.services.domain.llm.freshness import requires_verified_web_search
        return requires_verified_web_search
    if name in {"MessageClassification", "classify_message"}:
        import backend.services.domain.llm.message_classifier as mc
        return getattr(mc, name)
    if name in {
        "CLINICAL_PRO_PROMPT",
        "PRODUCT_BOUNDARY_PROMPT",
        "SAFETY_STYLE_PROMPT",
        "VALID_RAG_TAGS",
        "WELLNESS_ASSISTANT_PROMPT",
        "build_intent_context",
        "build_system_prompt",
        "build_tiered_prompt",
        "get_self_knowledge_response",
        "infer_response_mode",
        "infer_response_mode_for_preference",
    }:
        import backend.services.domain.llm.prompts as pr
        return getattr(pr, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    # Config
    "Settings",
    "get_settings",
    "reset_settings",

    # Database Primitives
    "DatabaseEngine",
    "DatabaseSession",
    "get_db_session",

    # Errors
    "AppError",
    "AuthError",
    "AuthServiceError",
    "ConfigError",
    "DatabaseError",
    "DatabaseServiceError",
    "InputTooLongError",
    "LLMServiceError",
    "MemoryAppError",
    "MemoryServiceError",
    "MindPalError",
    "OutputGuardError",
    "OutputGuardServiceError",
    "PermissionDeniedError",
    "ProviderError",
    "ProviderTimeoutError",
    "RAGError",
    "RAGServiceError",
    "RateLimitError",
    "SafetyError",
    "SafetyServiceError",
    "SecurityError",
    "SettingsError",
    "TTSError",
    "TTSServiceError",
    "ValidationAppError",

    # Logging
    "configure_logging",
    "get_logger",
    "log_event",

    # Middleware
    "RequestBodyLimitMiddleware",

    # Security & Sanitization
    "Locale",
    "generate_request_id",
    "hash_user_id",
    "normalize_locale",
    "redact_basic_pii",
    "safe_truncate",
    "sanitize_text",
    "strip_invisible_chars",
    "validate_url",

    # Settings Helpers
    "parse_bool_setting",
    "parse_float_setting",
    "parse_int_setting",
    "parse_json_setting",
    "parse_string_list_setting",

    # Validation & URL utilities
    "is_safe_url",
    "validate_email",
    "validate_input_length",

    # Domain Compatibility Re-exports
    "CLINICAL_PRO_PROMPT",
    "PRODUCT_BOUNDARY_PROMPT",
    "SAFETY_STYLE_PROMPT",
    "VALID_RAG_TAGS",
    "WELLNESS_ASSISTANT_PROMPT",
    "MessageClassification",
    "build_intent_context",
    "build_system_prompt",
    "build_tiered_prompt",
    "classify_message",
    "get_self_knowledge_response",
    "infer_response_mode",
    "infer_response_mode_for_preference",
    "requires_verified_web_search",
]

# Backward compatibility aliases for incorrect casing
RagError = RAGError
RagServiceError = RAGServiceError
