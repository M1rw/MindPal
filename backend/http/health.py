# backend/http/health.py

from __future__ import annotations

from fastapi import APIRouter

from backend.core.errors import AppError
from backend.domain.release.changelog import current_version

router = APIRouter(tags=["health"])


@router.get("/api/health", operation_id="healthLive")
def health_live() -> dict[str, str]:
    return {"status": "rebuilding", "version": current_version()}


@router.get("/api/health/ready", operation_id="healthReady")
def health_ready() -> dict[str, str]:
    raise AppError("unavailable", "Dependencies are not wired on the platform rebuild yet.")
