# backend/http/release.py

from __future__ import annotations

from fastapi import APIRouter

from backend.domain.release.changelog import load_changelog

router = APIRouter(tags=["release"])


@router.get("/api/release/changelog", operation_id="releaseChangelogGet")
def release_changelog_get() -> dict:
    return load_changelog()
