"""
Unified error handling system with recovery strategies.

All services use these error types to communicate failures in a
consistent, recoverable way. Each error type indicates:
- What went wrong (error code)
- Whether it's recoverable (can retry)
- How to handle it (timeout, fallback, etc.)

Error Recovery Strategies:
1. RETRY - transient error, safe to retry with backoff
2. FAIL_FAST - permanent error, don't retry
3. FALLBACK - use fallback provider/method
4. CIRCUIT_BREAK - too many failures, reject new requests
5. GRACEFUL_DEGRADE - partial service available

Example:
    try:
        response = await llm_provider.generate(prompt)
    except ExternalAPIError as e:
        if e.recoverable:
            # Retry with backoff
            await exponential_backoff()
        else:
            # Switch to fallback provider
            response = await offline_llm.generate(prompt)
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Optional


class ErrorCode(str, Enum):
    """Standard error codes for consistent error handling."""

    # Configuration errors (don't retry, requires manual intervention)
    CONFIG_MISSING = "CONFIG_MISSING"
    CONFIG_INVALID = "CONFIG_INVALID"

    # Initialization errors
    INIT_FAILED = "INIT_FAILED"
    CONNECTION_FAILED = "CONNECTION_FAILED"

    # Transient errors (retry with backoff)
    TIMEOUT = "TIMEOUT"
    RATE_LIMITED = "RATE_LIMITED"
    TEMPORARILY_UNAVAILABLE = "TEMPORARILY_UNAVAILABLE"
    NETWORK_ERROR = "NETWORK_ERROR"

    # Provider errors (switch provider)
    PROVIDER_ERROR = "PROVIDER_ERROR"
    PROVIDER_QUOTA_EXCEEDED = "PROVIDER_QUOTA_EXCEEDED"

    # Validation errors (fail fast)
    VALIDATION_ERROR = "VALIDATION_ERROR"
    INVALID_INPUT = "INVALID_INPUT"

    # Authentication errors (fail fast, don't retry)
    AUTH_ERROR = "AUTH_ERROR"
    AUTH_FAILED = "AUTH_FAILED"
    PERMISSION_DENIED = "PERMISSION_DENIED"

    # Resource errors
    RESOURCE_EXHAUSTED = "RESOURCE_EXHAUSTED"
    QUOTA_EXCEEDED = "QUOTA_EXCEEDED"
    DISK_FULL = "DISK_FULL"

    # Internal errors
    INTERNAL_ERROR = "INTERNAL_ERROR"
    NOT_IMPLEMENTED = "NOT_IMPLEMENTED"

    # Unknown (treat as transient)
    UNKNOWN = "UNKNOWN"


class RecoveryStrategy(str, Enum):
    """How to handle a service error."""

    RETRY = "retry"  # Retry with exponential backoff
    FAIL_FAST = "fail_fast"  # Don't retry, fail immediately
    FALLBACK = "fallback"  # Use fallback provider
    CIRCUIT_BREAK = "circuit_break"  # Reject new requests
    GRACEFUL_DEGRADE = "graceful_degrade"  # Partial service


@dataclass
class AppError(Exception):
    """
    Base application error with recovery strategy.

    Attributes:
        message: Human-readable error message
        error_code: Machine-readable error code (ErrorCode enum)
        service_name: Which service raised the error
        recovery_strategy: How to handle this error (RecoveryStrategy enum)
        details: Additional context (optional)
        cause: Original exception if any (optional)
        user_message: Message to show to end user (optional)
    """

    message: str
    error_code: ErrorCode
    service_name: str
    recovery_strategy: RecoveryStrategy
    details: dict[str, Any] | None = None
    cause: Exception | None = None
    user_message: str | None = None

    def __str__(self) -> str:
        return f"[{self.error_code}] {self.service_name}: {self.message}"

    def __repr__(self) -> str:
        return f"AppError({self.error_code}, {self.service_name})"

    @property
    def is_recoverable(self) -> bool:
        """Whether this error can be recovered from."""
        return self.recovery_strategy in (
            RecoveryStrategy.RETRY,
            RecoveryStrategy.FALLBACK,
            RecoveryStrategy.GRACEFUL_DEGRADE,
        )

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "error_code": self.error_code.value,
            "message": self.message,
            "service": self.service_name,
            "user_message": self.user_message or self.message,
            "details": self.details or {},
        }


class ConfigError(AppError):
    """Configuration is invalid or missing."""

    def __init__(
        self,
        message: str,
        service_name: str,
        details: dict[str, Any] | None = None,
        cause: Exception | None = None,
    ):
        super().__init__(
            message=message,
            error_code=ErrorCode.CONFIG_INVALID,
            service_name=service_name,
            recovery_strategy=RecoveryStrategy.FAIL_FAST,
            details=details,
            cause=cause,
            user_message="Service configuration error. Contact support.",
        )


class InitError(AppError):
    """Service failed to initialize."""

    def __init__(
        self,
        message: str,
        service_name: str,
        details: dict[str, Any] | None = None,
        cause: Exception | None = None,
    ):
        super().__init__(
            message=message,
            error_code=ErrorCode.INIT_FAILED,
            service_name=service_name,
            recovery_strategy=RecoveryStrategy.FAIL_FAST,
            details=details,
            cause=cause,
            user_message="Service initialization failed. Please try again.",
        )


class ValidationError(AppError):
    """Input validation failed."""

    def __init__(
        self,
        message: str,
        service_name: str,
        field: str | None = None,
        details: dict[str, Any] | None = None,
    ):
        if details is None:
            details = {}
        if field:
            details["field"] = field

        super().__init__(
            message=message,
            error_code=ErrorCode.VALIDATION_ERROR,
            service_name=service_name,
            recovery_strategy=RecoveryStrategy.FAIL_FAST,
            details=details,
            user_message=f"Invalid input: {message}",
        )


class AuthError(AppError):
    """Authentication or authorization failed."""

    def __init__(
        self,
        message: str,
        service_name: str,
        auth_type: str = "unknown",
        details: dict[str, Any] | None = None,
    ):
        if details is None:
            details = {}
        details["auth_type"] = auth_type

        super().__init__(
            message=message,
            error_code=ErrorCode.AUTH_FAILED,
            service_name=service_name,
            recovery_strategy=RecoveryStrategy.FAIL_FAST,
            details=details,
            user_message="Authentication failed. Please log in again.",
        )


class QuotaError(AppError):
    """User quota exceeded."""

    def __init__(
        self,
        message: str,
        service_name: str,
        quota_type: str = "unknown",
        reset_at: str | None = None,
        details: dict[str, Any] | None = None,
    ):
        if details is None:
            details = {}
        details["quota_type"] = quota_type
        if reset_at:
            details["reset_at"] = reset_at

        super().__init__(
            message=message,
            error_code=ErrorCode.QUOTA_EXCEEDED,
            service_name=service_name,
            recovery_strategy=RecoveryStrategy.FAIL_FAST,
            details=details,
            user_message=f"Quota exceeded: {quota_type}. Resets {reset_at or 'later'}.",
        )


class ProviderError(AppError):
    """External provider (LLM, TTS, etc.) failed."""

    def __init__(
        self,
        message: str,
        service_name: str,
        provider_name: str,
        retryable: bool = True,
        details: dict[str, Any] | None = None,
        cause: Exception | None = None,
    ):
        if details is None:
            details = {}
        details["provider"] = provider_name

        super().__init__(
            message=message,
            error_code=ErrorCode.PROVIDER_ERROR,
            service_name=service_name,
            recovery_strategy=RecoveryStrategy.RETRY if retryable else RecoveryStrategy.FALLBACK,
            details=details,
            cause=cause,
            user_message=f"Provider {provider_name} temporarily unavailable. Retrying...",
        )


class TimeoutError(AppError):
    """Operation timed out."""

    def __init__(
        self,
        message: str,
        service_name: str,
        timeout_seconds: float,
        details: dict[str, Any] | None = None,
    ):
        if details is None:
            details = {}
        details["timeout_seconds"] = timeout_seconds

        super().__init__(
            message=message,
            error_code=ErrorCode.TIMEOUT,
            service_name=service_name,
            recovery_strategy=RecoveryStrategy.RETRY,
            details=details,
            user_message="Operation timed out. Please try again.",
        )


class RateLimitError(AppError):
    """Rate limit exceeded."""

    def __init__(
        self,
        message: str,
        service_name: str,
        retry_after_seconds: int,
        details: dict[str, Any] | None = None,
    ):
        if details is None:
            details = {}
        details["retry_after_seconds"] = retry_after_seconds

        super().__init__(
            message=message,
            error_code=ErrorCode.RATE_LIMITED,
            service_name=service_name,
            recovery_strategy=RecoveryStrategy.RETRY,
            details=details,
            user_message=f"Rate limited. Please try again in {retry_after_seconds} seconds.",
        )


class InternalError(AppError):
    """Unexpected internal error."""

    def __init__(
        self,
        message: str,
        service_name: str,
        error_id: str | None = None,
        details: dict[str, Any] | None = None,
        cause: Exception | None = None,
    ):
        if details is None:
            details = {}
        if error_id:
            details["error_id"] = error_id

        super().__init__(
            message=message,
            error_code=ErrorCode.INTERNAL_ERROR,
            service_name=service_name,
            recovery_strategy=RecoveryStrategy.RETRY,
            details=details,
            cause=cause,
            user_message="An unexpected error occurred. Please try again.",
        )
