"""
Vercel Functions entry point for MindPal API.

This module serves as the serverless function handler that Vercel will invoke.
It exports the FastAPI application configured for the Vercel environment.
"""

from __future__ import annotations

# Configure environment defaults for Vercel serverless deployment.
# These are set defensively — they are overridden if the .env file provides them.
import os
os.environ.setdefault("ENVIRONMENT", "production")
os.environ.setdefault("DEBUG", "false")
os.environ.setdefault("PYTHONUNBUFFERED", "1")

# Import the FastAPI application
from backend.main import app

__all__ = ["app"]

# -----------------------------------------------------------------------------
# MindPal frontend static serving
# -----------------------------------------------------------------------------

def _mindpal_configure_frontend_static():
    from pathlib import Path as _Path

    from fastapi.responses import FileResponse as _FileResponse
    from fastapi.staticfiles import StaticFiles as _StaticFiles

    def _find_project_root() -> _Path:
        current = _Path(__file__).resolve()

        for parent in [current.parent, *current.parents]:
            if (parent / "frontend" / "index.html").exists():
                return parent

        return current.parents[1]

    project_root = _find_project_root()
    frontend_dir = project_root / "frontend"

    # Remove old frontend/static mounts if this function is called more than once.
    app.router.routes[:] = [
        route
        for route in app.router.routes
        if getattr(route, "path", None) not in {"/", "/css", "/js"}
    ]

    css_dir = frontend_dir / "css"
    js_dir = frontend_dir / "js"

    if css_dir.exists():
        app.mount("/css", _StaticFiles(directory=str(css_dir)), name="mindpal_frontend_css")

    if js_dir.exists():
        app.mount("/js", _StaticFiles(directory=str(js_dir)), name="mindpal_frontend_js")

    @app.get("/", include_in_schema=False)
    async def _mindpal_frontend_index():
        index_path = frontend_dir / "index.html"

        if index_path.exists():
            return _FileResponse(index_path)

        return {
            "name": "MindPal",
            "status": "ok",
            "health": "/api/health",
            "frontend": "missing",
            "expected_index": str(index_path),
        }


_mindpal_configure_frontend_static()
