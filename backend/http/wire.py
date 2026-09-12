# backend/http/wire.py

from __future__ import annotations

from fastapi import FastAPI

from backend.http.errors import app_error_handler
from backend.http.health import router as health_router
from backend.http.placeholders import register_preview_placeholders
from backend.http.release import router as release_router
from backend.core.errors import AppError

IMPLEMENTED = frozenset({"healthLive", "healthReady", "releaseChangelogGet"})


def wire_http(app: FastAPI) -> None:
    app.add_exception_handler(AppError, app_error_handler)
    app.include_router(health_router)
    app.include_router(release_router)
    app.include_router(register_preview_placeholders(set(IMPLEMENTED)))
