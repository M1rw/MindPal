# backend/core/__init__.py

"""
MindPal core infrastructure package.

This package contains framework-neutral foundations used by the rest of the
backend: configuration, structured logging, safe text utilities, prompt builders,
and application exception types.

Importing this package must not:
- load provider clients
- connect to databases
- read secrets beyond pydantic-settings definitions
- configure global logging
- call external services
"""

from __future__ import annotations

from .config import Settings, get_settings, reset_settings
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
from .prompts import (
    CLINICAL_PRO_PROMPT,
    PRODUCT_BOUNDARY_PROMPT,
    SAFETY_STYLE_PROMPT,
    VALID_RAG_TAGS,
    WELLNESS_ASSISTANT_PROMPT,
    build_intent_context,
    build_system_prompt,
    infer_response_mode,
    infer_response_mode_for_preference,
)
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

__all__ = [
    # Config
    "Settings",
    "get_settings",
    "reset_settings",
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
    # Prompts
    "CLINICAL_PRO_PROMPT",
    "PRODUCT_BOUNDARY_PROMPT",
    "SAFETY_STYLE_PROMPT",
    "VALID_RAG_TAGS",
    "WELLNESS_ASSISTANT_PROMPT",
    "build_intent_context",
    "build_system_prompt",
    "infer_response_mode",
    "infer_response_mode_for_preference",
    # Security
    "Locale",
    "generate_request_id",
    "hash_user_id",
    "normalize_locale",
    "redact_basic_pii",
    "safe_truncate",
    "sanitize_text",
    "strip_invisible_chars",
    "validate_url",
]

# Backward compatibility aliases for incorrect casing
RagError = RAGError
RagServiceError = RAGServiceError