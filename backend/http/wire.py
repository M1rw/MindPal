# backend/http/wire.py — Route Assembly and Wire Registration

from __future__ import annotations

from fastapi import FastAPI

from backend.core.errors import AppError
from backend.http.chat import router as chat_router
from backend.http.errors import app_error_handler
from backend.http.flags import router as flags_router
from backend.http.health import router as health_router
from backend.http.identity import router as identity_router
from backend.http.memory import router as memory_router
from backend.http.placeholders import register_preview_placeholders
from backend.http.release import router as release_router
from backend.http.sessions import router as sessions_router
from backend.http.system import router as system_router
from backend.http.voice import router as voice_router

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
        "identityExport",
        "identityDeleteData",
        "memoryGetGraph",
        "memoryPutGraph",
        "memoryDeleteGraphItem",
        "memoryGetSummary",
        "memoryRefreshSummary",
        "voiceCreateSessionToken",
        "flagsSnapshot",
        "systemRouteCatalog",
    }
)


def wire_http(app: FastAPI) -> None:
    app.add_exception_handler(AppError, app_error_handler)
    app.include_router(health_router)
    app.include_router(release_router)
    app.include_router(chat_router)
    app.include_router(sessions_router)
    app.include_router(identity_router)
    app.include_router(memory_router)
    app.include_router(voice_router)
    app.include_router(flags_router)
    app.include_router(system_router)
    app.include_router(register_preview_placeholders(set(IMPLEMENTED)))
