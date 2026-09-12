# backend/http/health.py

from __future__ import annotations

from fastapi import APIRouter

from backend.domain.release.changelog import current_version

router = APIRouter(tags=["health"])


@router.get("/api/health", operation_id="healthLive")
def health_live() -> dict[str, str]:
    return {"status": "rebuilding", "version": current_version()}


@router.get("/api/health/ready", operation_id="healthReady")
def health_ready() -> dict[str, str]:
    return {"status": "ready", "version": current_version()}
