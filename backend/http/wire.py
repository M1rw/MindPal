# backend/http/wire.py — Route Assembly and Wire Registration

from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from starlette.requests import Request

from backend.core.errors import AppError
from backend.http.chat import router as chat_router
from backend.http.dictation import router as dictation_router
from backend.http.errors import app_error_handler, error_payload, status_for_code
from backend.http.flags import router as flags_router
from backend.http.health import router as health_router
from backend.http.identity import router as identity_router
from backend.http.memory import router as memory_router
from backend.http.placeholders import register_preview_placeholders
from backend.http.release import router as release_router
from backend.http.sessions import router as sessions_router
from backend.http.system import router as system_router
from backend.http.usage import router as usage_router
from backend.http.voice import router as voice_router
from backend.http.voice_ops import router as voice_ops_router
from backend.http.ops import router as ops_router
from backend.core.request_context import request_id as current_request_id
from backend.core.storage import StoreUnavailable

logger = logging.getLogger("mindpal.http")

_ROUTERS = (
    health_router,
    release_router,
    chat_router,
    dictation_router,
    usage_router,
    sessions_router,
    identity_router,
    memory_router,
    voice_router,
    voice_ops_router,
    ops_router,
    flags_router,
    system_router,
)


async def _store_unavailable_handler(request: Request, exc: StoreUnavailable) -> JSONResponse:
    """Durable storage could not serve a write.

    503 with a retry hint, not a 500: nothing about the request was wrong, and
    the client should not treat it as permanent. The detail stays in the log —
    collection and document ids are not the caller's business.
    """
    logger.error("store_unavailable path=%s detail=%s", request.url.path, exc)
    return JSONResponse(
        status_code=status_for_code("unavailable"),
        content=error_payload(
            "unavailable",
            "MindPal could not reach storage for that change. Please try again in a moment.",
            request_id=current_request_id() or request.headers.get("x-request-id"),
        ),
    )


def _served_operation_ids(app: FastAPI) -> set[str]:
    return {
        str(route.operation_id)
        for route in app.routes
        if getattr(route, "operation_id", None)
    }


def wire_http(app: FastAPI) -> None:
    app.add_exception_handler(AppError, app_error_handler)
    app.add_exception_handler(StoreUnavailable, _store_unavailable_handler)
    for router in _ROUTERS:
        app.include_router(router)
    # Contract operations with no real route yet answer 501. What counts as
    # implemented is read from the routes actually served, so a new endpoint can
    # never be shadowed by a placeholder because a hand-kept list went stale.
    app.include_router(register_preview_placeholders(_served_operation_ids(app)))
