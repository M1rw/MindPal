# backend/http/wire.py — Route Assembly and Wire Registration

from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from starlette.requests import Request

from backend.core.errors import AppError
from backend.http.chat import router as chat_router
from backend.http.errors import app_error_handler, error_payload, status_for_code
from backend.http.flags import router as flags_router
from backend.http.health import router as health_router
from backend.http.identity import router as identity_router
from backend.http.memory import router as memory_router
from backend.http.placeholders import register_preview_placeholders
from backend.http.release import router as release_router
from backend.http.sessions import router as sessions_router
from backend.http.system import router as system_router
from backend.http.voice import router as voice_router
from backend.infra.store.store import StoreUnavailable

logger = logging.getLogger("mindpal.http")

IMPLEMENTED = frozenset(
    {
        "healthLive",
        "healthReady",
        "releaseChangelogGet",
        "releaseChangelogDismiss",
        "chatStream",
        "sessionsGetCurrent",
        "sessionsReplaceCurrent",
        "sessionsDeleteCurrent",
        "sessionsAppendMessages",
        "identityMe",
        "identityGetProfile",
        "identityPatchProfile",
        "identityGetInsights",
        "identityGetWellnessTimeline",
        "identityExport",
        "identityDeleteData",
        "memoryGetGraph",
        "memoryPutGraph",
        "memoryDeleteGraphItem",
        "memoryPatchGraphItem",
        "memoryGetSummary",
        "memoryRefreshSummary",
        "voiceCreateSessionToken",
        "voiceRecordSessionEvent",
        "voiceClassifyReaction",
        "voiceRecall",
        "voiceSummarizeSession",
        # Live route used by the Usage settings screen. Omitting it registered a
        # 501 placeholder over the same path: the real router still won on order,
        # but the app carried a duplicate operationId and a landmine one route
        # reshuffle away from taking the endpoint down.
        "voiceGetUsage",
        "greetingGet",
        "flagsSnapshot",
        "systemRouteCatalog",
        "chatsList",
        "chatsSave",
        "chatsGet",
        "chatsDelete",
        "sessionsRecordTelemetry",
    }
)

_ROUTERS = (
    health_router,
    release_router,
    chat_router,
    sessions_router,
    identity_router,
    memory_router,
    voice_router,
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
            request_id=request.headers.get("x-request-id"),
        ),
    )


def _assert_implemented_operations_exist(app: FastAPI) -> None:
    """Fail loudly when IMPLEMENTED names an operation no router actually serves.

    The registry drifting from the routers is silent by nature: a missing name
    shadows a live route with a 501 placeholder, and a stale name hides a route
    that was deleted. Both used to survive to production.
    """
    served = {
        getattr(route, "operation_id", None)
        for route in app.routes
        if getattr(route, "operation_id", None)
    }
    missing = sorted(name for name in IMPLEMENTED if name not in served)
    if missing:
        raise RuntimeError(f"IMPLEMENTED lists operations with no route: {missing}")


def wire_http(app: FastAPI) -> None:
    app.add_exception_handler(AppError, app_error_handler)
    app.add_exception_handler(StoreUnavailable, _store_unavailable_handler)
    for router in _ROUTERS:
        app.include_router(router)
    _assert_implemented_operations_exist(app)
    app.include_router(register_preview_placeholders(set(IMPLEMENTED)))
