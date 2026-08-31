# backend/core/validation.py

from __future__ import annotations

from typing import Any, Final

from backend.core.errors import InputTooLongError, ValidationAppError
from backend.core.security import Locale, normalize_locale, sanitize_text

DEFAULT_MAX_TEXT_CHARS: Final[int] = 4_000
MAX_USER_ID_CHARS: Final[int] = 160
MAX_REQUEST_ID_CHARS: Final[int] = 120
MAX_OPERATION_CHARS: Final[int] = 80


def validate_text(
    value: Any,
    *,
    field_name: str,
    max_chars: int = DEFAULT_MAX_TEXT_CHARS,
    min_chars: int = 1,
    allow_blank: bool = False,
) -> str:
    """
    Sanitize and validate string bounds or raise structured ValidationAppError/InputTooLongError.

    Args:
        value: Input value to validate.
        field_name: Name of field for error detail reporting.
        max_chars: Upper boundary character count limit.
        min_chars: Minimum required character count.
        allow_blank: If True, empty strings pass validation.

    Returns:
        Sanitized valid string value.
    """
    cleaned = sanitize_text(str(value or ""), max_chars)
    if not allow_blank and not cleaned:
        raise ValidationAppError(
            f"{field_name} cannot be empty",
            code="validation_error",
            status_code=422,
            details={"field": field_name, "max_chars": max_chars},
        )
    if not allow_blank and len(cleaned) < min_chars:
        raise ValidationAppError(
            f"{field_name} is too short",
            code="validation_error",
            status_code=422,
            details={"field": field_name, "min_chars": min_chars},
        )
    if value is not None and len(str(value)) > max_chars:
        raise InputTooLongError(
            f"{field_name} exceeds the maximum length of {max_chars} characters",
            details={"field": field_name, "max_chars": max_chars},
        )
    return cleaned


def validate_user_id(value: Any, *, field_name: str = "user_id") -> str:
    """Validate user ID string."""
    cleaned = validate_text(value, field_name=field_name, max_chars=MAX_USER_ID_CHARS)
    return cleaned or "anonymous"


def validate_request_id(value: Any, *, field_name: str = "request_id") -> str:
    """Validate correlation request ID string."""
    return validate_text(value, field_name=field_name, max_chars=MAX_REQUEST_ID_CHARS)


def validate_operation(value: Any, *, field_name: str = "operation") -> str:
    """Validate operation string identifier."""
    return validate_text(value, field_name=field_name, max_chars=MAX_OPERATION_CHARS)


def validate_locale(value: Any, *, field_name: str = "locale") -> Locale:
    """Validate locale string and convert to normalized locale code."""
    locale = str(value or "auto").strip() or "auto"
    try:
        return normalize_locale(locale)
    except ValueError as exc:
        raise ValidationAppError(
            f"{field_name} must be a valid locale",
            code="validation_error",
            status_code=422,
            details={"field": field_name, "value": locale},
        ) from exc


def validate_positive_int(value: Any, *, field_name: str, minimum: int = 1) -> int:
    """Validate integer value against minimum bound."""
    try:
        number = int(value)
    except (TypeError, ValueError) as exc:
        raise ValidationAppError(
            f"{field_name} must be an integer",
            code="validation_error",
            status_code=422,
            details={"field": field_name, "value": value},
        ) from exc
    if number < minimum:
        raise ValidationAppError(
            f"{field_name} must be at least {minimum}",
            code="validation_error",
            status_code=422,
            details={"field": field_name, "value": number},
        )
    return number


def validate_quota_request(
    user_id_hash: Any,
    request_id: Any,
    cost: Any = 1,
    operation: Any = "chat",
) -> tuple[str, str, int, str]:
    """Validate quota reservation request arguments."""
    normalized_user = validate_user_id(user_id_hash, field_name="user_id_hash")
    normalized_request = validate_request_id(request_id, field_name="request_id")
    normalized_cost = validate_positive_int(cost, field_name="cost", minimum=1)
    normalized_operation = validate_operation(operation, field_name="operation")
    return normalized_user, normalized_request, normalized_cost, normalized_operation


def validate_history_messages(messages: Any, *, field_name: str = "history", max_messages: int = 100) -> list[Any]:
    """Validate array of conversation history messages."""
    if messages is None:
        return []
    if not isinstance(messages, list):
        raise ValidationAppError(
            f"{field_name} must be a list",
            code="validation_error",
            status_code=422,
            details={"field": field_name},
        )
    if len(messages) > max_messages:
        raise ValidationAppError(
            f"{field_name} exceeds the maximum number of messages",
            code="validation_error",
            status_code=422,
            details={"field": field_name, "max_messages": max_messages, "actual": len(messages)},
        )
    for index, item in enumerate(messages):
        if not isinstance(item, dict):
            raise ValidationAppError(
                f"{field_name}[{index}] must be an object",
                code="validation_error",
                status_code=422,
                details={"field": f"{field_name}[{index}]"},
            )
        content = item.get("content")
        if content is not None:
            validate_text(content, field_name=f"{field_name}[{index}].content", max_chars=4_000)
    return messages


def validate_chat_payload(payload: Any) -> dict[str, Any]:
    """Validate incoming chat request dictionary payload."""
    if not isinstance(payload, dict):
        raise ValidationAppError(
            "chat payload must be an object",
            code="validation_error",
            status_code=422,
            details={"field": "payload"},
        )
    message = payload.get("message")
    if message is None:
        raise ValidationAppError(
            "message is required",
            code="validation_error",
            status_code=422,
            details={"field": "message"},
        )
    validate_text(message, field_name="message", max_chars=4_000)
    validate_history_messages(payload.get("history", []), field_name="history")
    if payload.get("metadata") is not None and not isinstance(payload.get("metadata"), dict):
        raise ValidationAppError(
            "metadata must be an object when provided",
            code="validation_error",
            status_code=422,
            details={"field": "metadata"},
        )
    return payload
