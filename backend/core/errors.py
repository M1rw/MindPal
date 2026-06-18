# backend/core/errors.py

from __future__ import annotations

from typing import Any


class MindPalError(Exception):
    """
    Base MindPal exception.

    Keep this name stable because backend/core/__init__.py and older modules
    may import it directly.
    """

    status_code: int = 500
    code: str = "mindpal_error"

    def __init__(
        self,
        message: str = "MindPal application error",
        *,
        code: str | None = None,
        status_code: int | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code or self.code
        self.status_code = status_code or self.status_code
        self.details = details or {}


class AppError(MindPalError):
    """
    Preferred current base application error.

    AppError intentionally inherits MindPalError for backward compatibility.
    """

    code = "app_error"


class ConfigError(AppError):
    status_code = 500
    code = "config_error"


class SettingsError(ConfigError):
    code = "settings_error"


class SecurityError(AppError):
    status_code = 400
    code = "security_error"


class AuthError(AppError):
    status_code = 401
    code = "auth_error"


class AuthServiceError(AuthError):
    code = "auth_service_error"


class PermissionDeniedError(AppError):
    status_code = 403
    code = "permission_denied"


class ValidationAppError(AppError):
    status_code = 422
    code = "validation_error"


class InputTooLongError(ValidationAppError):
    """User input exceeds the maximum allowed length."""

    code = "input_too_long"


class ProviderError(AppError):
    status_code = 502
    code = "provider_error"


class ProviderTimeoutError(ProviderError):
    status_code = 504
    code = "provider_timeout"


class RateLimitError(ProviderError):
    """Provider returned 429 Too Many Requests."""

    status_code = 429
    code = "rate_limit_exceeded"


class LLMServiceError(ProviderError):
    code = "llm_service_error"


class DatabaseError(AppError):
    status_code = 500
    code = "database_error"


class DatabaseServiceError(DatabaseError):
    code = "database_service_error"


class SafetyError(AppError):
    status_code = 500
    code = "safety_error"


class SafetyServiceError(SafetyError):
    code = "safety_service_error"


class MemoryAppError(AppError):
    status_code = 500
    code = "memory_error"



class MemoryServiceError(MemoryAppError):
    code = "memory_service_error"


class RAGError(AppError):
    status_code = 500
    code = "rag_error"


class RAGServiceError(RAGError):
    code = "rag_service_error"


class OutputGuardError(AppError):
    status_code = 500
    code = "output_guard_error"


class OutputGuardServiceError(OutputGuardError):
    code = "output_guard_service_error"


class TTSError(AppError):
    status_code = 500
    code = "tts_error"


class TTSServiceError(TTSError):
    code = "tts_service_error"


__all__ = [
    "AppError",
    "AuthError",
    "AuthServiceError",
    "ConfigError",
    "DatabaseError",
    "DatabaseServiceError",
    "InputTooLongError",
    "LLMServiceError",
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
    "RateLimitError",
    "SafetyError",
    "SafetyServiceError",
    "SecurityError",
    "SettingsError",
    "TTSError",
    "TTSServiceError",
    "ValidationAppError",
]