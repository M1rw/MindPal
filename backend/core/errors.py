# backend/core/errors.py

from __future__ import annotations

from collections.abc import Mapping
from http import HTTPStatus
from typing import Any


class MindPalError(Exception):
    """
    Base application exception.

    All domain errors carry:
    - stable machine-readable code
    - HTTP status code
    - optional structured details

    details must not contain raw user messages, secrets, tokens, or provider
    payloads unless explicitly sanitized before being passed here.
    """

    default_code = "mindpal_error"
    default_status_code = HTTPStatus.INTERNAL_SERVER_ERROR

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        status_code: int | HTTPStatus | None = None,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        clean_message = str(message).strip()
        if not clean_message:
            clean_message = self.default_code

        resolved_status = int(status_code or self.default_status_code)
        if resolved_status < 100 or resolved_status > 599:
            raise ValueError("status_code must be a valid HTTP status code")

        self.message = clean_message
        self.code = code or self.default_code
        self.status_code = resolved_status
        self.details = dict(details or {})

        super().__init__(self.message)

    def to_dict(self) -> dict[str, Any]:
        return {
            "error": {
                "code": self.code,
                "message": self.message,
                "status_code": self.status_code,
                "details": self.details,
            }
        }

    def __repr__(self) -> str:
        return (
            f"{self.__class__.__name__}("
            f"message={self.message!r}, "
            f"code={self.code!r}, "
            f"status_code={self.status_code!r}, "
            f"details={self.details!r})"
        )


class ConfigError(MindPalError):
    default_code = "config_error"
    default_status_code = HTTPStatus.INTERNAL_SERVER_ERROR


class ValidationError(MindPalError):
    default_code = "validation_error"
    default_status_code = HTTPStatus.BAD_REQUEST


class SafetyError(MindPalError):
    default_code = "safety_error"
    default_status_code = HTTPStatus.INTERNAL_SERVER_ERROR


class ProviderError(MindPalError):
    default_code = "provider_error"
    default_status_code = HTTPStatus.BAD_GATEWAY


class ProviderTimeoutError(ProviderError):
    default_code = "provider_timeout"
    default_status_code = HTTPStatus.GATEWAY_TIMEOUT


class DatabaseError(MindPalError):
    default_code = "database_error"
    default_status_code = HTTPStatus.INTERNAL_SERVER_ERROR


class MemoryServiceError(MindPalError):
    """
    Memory subsystem error.

    Named MemoryServiceError to avoid confusing it with Python's built-in
    MemoryError while keeping a compatibility alias below for the architecture
    contract.
    """

    default_code = "memory_error"
    default_status_code = HTTPStatus.INTERNAL_SERVER_ERROR


class RagError(MindPalError):
    default_code = "rag_error"
    default_status_code = HTTPStatus.INTERNAL_SERVER_ERROR


class AuthError(MindPalError):
    default_code = "auth_error"
    default_status_code = HTTPStatus.UNAUTHORIZED


# Compatibility alias for the original architecture name.
# Prefer importing MemoryServiceError in new code.
MemoryError = MemoryServiceError