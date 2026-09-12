# backend/main.py

from __future__ import annotations

import json
import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from backend.http.wire import wire_http

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"


def create_app(*, serve_frontend: bool = True) -> FastAPI:
    app = FastAPI(title="MindPal", version="5.0.0", docs_url=None, redoc_url=None)

    @app.middleware("http")
    async def add_security_headers(request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        return response

    wire_http(app)

    if serve_frontend and FRONTEND.exists():
        _mount_frontend(app)
    return app


def _mount_frontend(app: FastAPI) -> None:
    for prefix, folder in (
        ("/css", FRONTEND / "css"),
        ("/js", FRONTEND / "js"),
        ("/dist", FRONTEND / "dist"),
        ("/assets", FRONTEND / "assets"),
    ):
        if folder.exists():
            app.mount(prefix, StaticFiles(directory=str(folder)), name=prefix.strip("/"))

    @app.get("/runtime-config.js", include_in_schema=False)
    def runtime_config() -> Response:
        payload = {
            "API_BASE_URL": os.environ.get("PUBLIC_API_BASE_URL", "/api").strip() or "/api",
            "ENVIRONMENT": os.environ.get("ENVIRONMENT", "production"),
            "VOICE_V4_PREVIEW_APPROVED": False,
            "VOICE_V4_PREVIEW_SESSION_ENABLED": False,
            "VOICE_V4_DIAGNOSTICS": False,
            "SHOW_RESPONSE_DEBUG": False,
            "FIREBASE_APPCHECK_SITE_KEY": os.environ.get("FIREBASE_APPCHECK_SITE_KEY", "").strip(),
            "FIREBASE_CONFIG": None,
            "FIREBASE_ENABLED": False,
        }
        script = (
            "(() => { window.MINDPAL_CONFIG = Object.freeze("
            + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
            + "); })();"
        )
        return Response(content=script, media_type="text/javascript; charset=utf-8", headers={"Cache-Control": "no-store"})

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(FRONTEND / "index.html")


app = create_app()
