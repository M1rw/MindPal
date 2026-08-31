# backend/core/errors.py

from __future__ import annotations

from typing import Any


class MindPalError(Exception):
    """
    Base exception class for all MindPal domain and application errors.
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
        self.message: str = message
        self.code: str = code or self.code
        self.status_code: int = status_code or self.status_code
        self.details: dict[str, Any] = details or {}


class AppError(MindPalError):
    """Base error for general application business logic failures."""

    code = "app_error"


class ConfigError(AppError):
    """Error raised when configuration initialization or validation fails."""

    status_code = 500
    code = "config_error"


class SettingsError(ConfigError):
    """Error raised for settings resolution failures."""

    code = "settings_error"


class SecurityError(AppError):
    """Error raised when security or sanitization checks fail."""

    status_code = 400
    code = "security_error"


class AuthError(AppError):
    """Error raised when user or client authentication fails."""

    status_code = 401
    code = "auth_error"


class AuthServiceError(AuthError):
    """Error raised during authentication provider execution."""

    code = "auth_service_error"


class PermissionDeniedError(AppError):
    """Error raised when authorization check denies access."""

    status_code = 403
    code = "permission_denied"


class ValidationAppError(AppError):
    """Error raised when boundary request validation fails."""

    status_code = 422
    code = "validation_error"


class InputTooLongError(ValidationAppError):
    """User input exceeds the maximum allowed character budget."""

    code = "input_too_long"


class ProviderError(AppError):
    """Error raised when an external LLM, TTS, or API provider fails."""

    status_code = 502
    code = "provider_error"


class ProviderTimeoutError(ProviderError):
    """Error raised when an external provider request times out."""

    status_code = 504
    code = "provider_timeout"


class RateLimitError(ProviderError):
    """Error raised when provider or endpoint rate limits are exceeded."""

    status_code = 429
    code = "rate_limit_exceeded"


class LLMServiceError(ProviderError):
    """Error raised during LLM orchestration."""

    code = "llm_service_error"


class DatabaseError(AppError):
    """Error raised during database persistence operations."""

    status_code = 500
    code = "database_error"


class DatabaseServiceError(DatabaseError):
    """Error raised during database domain service operations."""

    code = "database_service_error"


class SafetyError(AppError):
    """Error raised during safety classification or crisis rule evaluation."""

    status_code = 500
    code = "safety_error"


class SafetyServiceError(SafetyError):
    """Error raised by safety orchestration service."""

    code = "safety_service_error"


class MemoryAppError(AppError):
    """Error raised during memory extraction or compaction."""

    status_code = 500
    code = "memory_error"


class MemoryServiceError(MemoryAppError):
    """Error raised by memory domain service."""

    code = "memory_service_error"


class RAGError(AppError):
    """Error raised during RAG retrieval or planning."""

    status_code = 500
    code = "rag_error"


class RAGServiceError(RAGError):
    """Error raised by RAG service."""

    code = "rag_service_error"


class OutputGuardError(AppError):
    """Error raised during output guard evaluation."""

    status_code = 500
    code = "output_guard_error"


class OutputGuardServiceError(OutputGuardError):
    """Error raised by output guard service."""

    code = "output_guard_service_error"


class TTSError(AppError):
    """Error raised during text-to-speech synthesis."""

    status_code = 500
    code = "tts_error"


class TTSServiceError(TTSError):
    """Error raised by TTS service."""

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
