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

from .config import Settings, get_settings
from .errors import (
    AuthError,
    ConfigError,
    DatabaseError,
    MemoryError,
    MemoryServiceError,
    MindPalError,
    ProviderError,
    ProviderTimeoutError,
    RagError,
    SafetyError,
    ValidationError,
)
from .logging import configure_logging, get_logger, log_event
from .prompts import (
    PRODUCT_BOUNDARY_PROMPT,
    SAFETY_STYLE_PROMPT,
    WELLNESS_ASSISTANT_PROMPT,
    build_system_prompt,
)
from .security import (
    Locale,
    generate_request_id,
    hash_user_id,
    normalize_locale,
    redact_basic_pii,
    safe_truncate,
    sanitize_text,
)

__all__ = [
    "AppError",
    "AuthError",
    "AuthServiceError",
    "ConfigError",
    "DatabaseError",
    "DatabaseServiceError",
    "LLMServiceError",
    "LlmServiceError",
    "MemoryAppError",
    "MemoryError",
    "MemoryServiceError",
    "MindPalError",
    "OutputGuardError",
    "OutputGuardServiceError",
    "PermissionDeniedError",
    "ProviderError",
    "ProviderTimeoutError",
    "RAGError",
    "RAGServiceError",
    "RagError",
    "RagServiceError",
    "SafetyError",
    "SafetyServiceError",
    "SecurityError",
    "SettingsError",
    "TTSError",
    "TTSServiceError",
    "TtsError",
    "TtsServiceError",
    "ValidationAppError",
]