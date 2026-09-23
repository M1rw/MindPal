# backend/http/health.py

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from backend.domain.release.changelog import current_version
from backend.core.storage import storage_health

router = APIRouter(tags=["health"])


@router.get("/api/health", operation_id="healthLive")
def health_live() -> dict[str, str]:
    return {"status": "ok", "version": current_version()}


@router.get("/api/health/ready", operation_id="healthReady")
def health_ready() -> dict[str, object]:
    storage = storage_health()
    payload = {
        "status": "ready" if storage["status"] == "ok" else "degraded",
        "version": current_version(),
        "storage": storage,
    }
    if storage["status"] != "ok":
        raise HTTPException(status_code=503, detail=payload)
    return payload
