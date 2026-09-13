# backend/main.py

from __future__ import annotations

import json
import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from backend.http.wire import wire_http

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"


def _load_env_files() -> None:
    """Load .env and .env.local without external dependencies for local runs."""
    for filename in (".env", ".env.local"):
        p = ROOT / filename
        if not p.exists():
            continue
        try:
            for raw_line in p.read_text(encoding="utf-8").splitlines():
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
        except Exception:
            pass


_load_env_files()


def create_app(*, serve_frontend: bool = True) -> FastAPI:
    app = FastAPI(title="MindPal", version="5.0.0", docs_url=None, redoc_url=None)

    @app.middleware("http")
    async def add_security_headers(request: Request, call_next):
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
        api_key = os.environ.get("FIREBASE_WEB_API_KEY", "").strip() or os.environ.get("FIREBASE_API_KEY", "").strip()
        project_id = (
            os.environ.get("FIREBASE_WEB_PROJECT_ID", "").strip()
            or os.environ.get("FIREBASE_PROJECT_ID", "").strip()
            or os.environ.get("GOOGLE_CLOUD_PROJECT", "").strip()
        )
        app_id = os.environ.get("FIREBASE_WEB_APP_ID", "").strip() or os.environ.get("FIREBASE_APP_ID", "").strip()
        auth_domain = os.environ.get("FIREBASE_AUTH_DOMAIN", "").strip() or (f"{project_id}.firebaseapp.com" if project_id else "")
        storage_bucket = os.environ.get("FIREBASE_STORAGE_BUCKET", "").strip() or (f"{project_id}.appspot.com" if project_id else "")
        messaging_sender_id = os.environ.get("FIREBASE_MESSAGING_SENDER_ID", "").strip()
        measurement_id = os.environ.get("FIREBASE_MEASUREMENT_ID", "").strip()
        google_client_id = os.environ.get("FIREBASE_WEB_GOOGLE_CLIENT_ID", "").strip()
        app_check_site_key = os.environ.get("FIREBASE_APPCHECK_SITE_KEY", "").strip()
        enable_firebase_env = os.environ.get("ENABLE_FIREBASE", "true").strip().lower()
        firebase_allowed = enable_firebase_env not in ("false", "0", "no")
        firebase_ready = bool(firebase_allowed and api_key and project_id and app_id)
        firebase_config = (
            {
                "apiKey": api_key,
                "authDomain": auth_domain,
                "projectId": project_id,
                "storageBucket": storage_bucket,
                "messagingSenderId": messaging_sender_id,
                "appId": app_id,
                "measurementId": measurement_id,
                "googleClientId": google_client_id,
            }
            if firebase_ready
            else None
        )

        payload = {
            "API_BASE_URL": os.environ.get("PUBLIC_API_BASE_URL", "/api").strip() or "/api",
            "ENVIRONMENT": os.environ.get("ENVIRONMENT", "production"),
            "FIREBASE_APPCHECK_SITE_KEY": app_check_site_key,
            "FIREBASE_CONFIG": firebase_config,
            "FIREBASE_ENABLED": firebase_ready,
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
