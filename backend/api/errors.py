# backend/api/errors.py

"""
Centralized HTTP exception mapping for MindPal domain errors.

Maps framework-agnostic domain AppError exceptions to appropriate HTTP status codes,
JSON error detail bodies, and headers.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import Request, status
from fastapi.responses import JSONResponse

from backend.core.errors import (
    AppError,
    AuthError,
    DatabaseError,
    InputTooLongError,
    PermissionDeniedError,
    ProviderTimeoutError,
    RateLimitError,
    SafetyError,
    ValidationAppError,
)
from backend.core.security import generate_request_id, sanitize_text

logger = logging.getLogger("mindpal.api.errors")

_STATUS_CODE_MAP: dict[type[AppError], int] = {
    AuthError: status.HTTP_401_UNAUTHORIZED,
    PermissionDeniedError: status.HTTP_403_FORBIDDEN,
    ValidationAppError: status.HTTP_422_UNPROCESSABLE_CONTENT,
    InputTooLongError: status.HTTP_413_CONTENT_TOO_LARGE,
    RateLimitError: status.HTTP_429_TOO_MANY_REQUESTS,
    ProviderTimeoutError: status.HTTP_504_GATEWAY_TIMEOUT,
    DatabaseError: status.HTTP_500_INTERNAL_SERVER_ERROR,
    SafetyError: status.HTTP_400_BAD_REQUEST,
}


def map_domain_error_to_http(exc: AppError, request: Request | None = None) -> JSONResponse:
    """Map domain AppError to standardized FastAPI JSONResponse."""
    status_code = getattr(exc, "status_code", None)
    if status_code is None:
        for exc_type, mapped_code in _STATUS_CODE_MAP.items():
            if isinstance(exc, exc_type):
                status_code = mapped_code
                break
        if status_code is None:
            status_code = status.HTTP_500_INTERNAL_SERVER_ERROR

    details = getattr(exc, "details", None) or {}
    headers: dict[str, str] = {}

    retry_after = details.get("retry_after_seconds") if isinstance(details, dict) else None
    if isinstance(retry_after, (int, float)) and retry_after > 0:
        headers["Retry-After"] = str(max(1, int(retry_after)))

    request_id = ""
    if request is not None:
        request_id = sanitize_text(
            str(getattr(request.state, "request_id", "") or ""),
            120,
        )
    if not request_id:
        request_id = generate_request_id()

    payload = {
        "code": sanitize_text(getattr(exc, "code", None) or exc.__class__.__name__, 120),
        "message": sanitize_text(str(exc) or "Application error", 700),
        "details": details,
        "request_id": request_id,
    }

    return JSONResponse(
        status_code=status_code,
        content=payload,
        headers=headers,
    )
