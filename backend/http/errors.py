# backend/http/errors.py

from __future__ import annotations

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
        body["details"] = details
    return body


def status_for_code(code: str) -> int:
    catalog = error_catalog()
    entry = catalog.get(code) or catalog["internal"]
    return int(entry["status"])


async def app_error_handler(_request: Request, exc: AppError) -> JSONResponse:
    request_id = _request.headers.get("x-request-id")
    return JSONResponse(
        status_code=status_for_code(exc.code),
        content=error_payload(exc.code, exc.message, request_id=request_id, details=exc.details or None),
    )
