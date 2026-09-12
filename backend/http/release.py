# backend/http/release.py

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from backend.domain.release.changelog import load_changelog

router = APIRouter(tags=["release"])


@router.get("/api/release/changelog", operation_id="releaseChangelogGet")
def release_changelog_get() -> JSONResponse:
    return JSONResponse(
        content=load_changelog(),
        headers={"Cache-Control": "public, max-age=300, stale-while-revalidate=600"},
    )
