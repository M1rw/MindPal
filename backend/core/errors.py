# backend/core/errors.py

from __future__ import annotations

from typing import Any


class AppError(Exception):
    """
    Base application error.

    Routers convert this into structured HTTP responses.
    """

    status_code: int = 500
    code: str = "app_error"

    def __init__(
        self,
        message: str = "Application error",
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


class ConfigError(AppError):
    status_code = 500
    code = "config_error"


class AuthError(AppError):
    status_code = 401
    code = "auth_error"


class PermissionDeniedError(AppError):
    status_code = 403
    code = "permission_denied"


class ValidationAppError(AppError):
    status_code = 422
    code = "validation_error"


class ProviderError(AppError):
    status_code = 502
    code = "provider_error"


class ProviderTimeoutError(ProviderError):
    status_code = 504
    code = "provider_timeout"


class DatabaseError(AppError):
    status_code = 500
    code = "database_error"


class SafetyError(AppError):
    status_code = 500
    code = "safety_error"


class MemoryError(AppError):
    status_code = 500
    code = "memory_error"


class RAGError(AppError):
    status_code = 500
    code = "rag_error"


class TTSError(AppError):
    status_code = 500
    code = "tts_error"


__all__ = [
    "AppError",
    "AuthError",
    "ConfigError",
    "DatabaseError",
    "MemoryError",
    "PermissionDeniedError",
    "ProviderError",
    "ProviderTimeoutError",
    "RAGError",
    "SafetyError",
    "TTSError",
    "ValidationAppError",
]