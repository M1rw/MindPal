# backend/http/errors.py

from __future__ import annotations

import logging
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse

from backend.core.contract import error_catalog
from backend.core.errors import AppError


def error_payload(code: str, message: str, *, request_id: str | None = None, details: dict[str, Any] | None = None) -> dict[str, Any]:
    catalog = error_catalog()
    entry = catalog.get(code) or catalog["internal"]
    body: dict[str, Any] = {
        "code": code if code in catalog else "internal",
        "message": message or code,
        "client_action": entry.get("client_action", "retry"),
    }
    if request_id:
        body["request_id"] = request_id
    if details:
        body["details"] = _public_details(details)
    return body


# Diagnostic keys that help an operator in a log but tell a caller about the
# upstream vendor, its endpoints and its status codes. Kept out of responses.
_INTERNAL_DETAIL_KEYS = frozenset(
    {"provider_endpoint", "provider_status", "provider_status_name", "provider_body"}
)


def _public_details(details: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in details.items() if key not in _INTERNAL_DETAIL_KEYS}


def status_for_code(code: str) -> int:
    catalog = error_catalog()
    entry = catalog.get(code) or catalog["internal"]
    return int(entry["status"])


logger = logging.getLogger("mindpal.http")


async def app_error_handler(_request: Request, exc: AppError) -> JSONResponse:
    request_id = _request.headers.get("x-request-id")
    if exc.internal_message != exc.message:
        # The caller gets the safe sentence; the operator gets the upstream one.
        logger.warning(
            "app_error code=%s path=%s detail=%s",
            exc.code,
            _request.url.path,
            exc.internal_message,
        )
    return JSONResponse(
        status_code=status_for_code(exc.code),
        content=error_payload(exc.code, exc.message, request_id=request_id, details=exc.details or None),
    )
