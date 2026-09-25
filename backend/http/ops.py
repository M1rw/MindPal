"""Scheduler and operations endpoints (never called by the web client)."""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Header

from backend.configs.settings import get_settings
from backend.core.errors import AppError
from backend.domain.operations import platform_status, run_scheduled_consolidation
from backend.http.memory import consolidation
from backend.http.voice_ops import _secret_matches

router = APIRouter()


def _require_scheduler(x_cron_secret: Optional[str], authorization: Optional[str]) -> None:
    bearer = authorization.removeprefix("Bearer ").strip() if authorization else ""
    presented = [value for value in (x_cron_secret or "", bearer) if value]
    if not any(_secret_matches(value, secret) for value in presented for secret in get_settings().scheduler_secrets()):
        raise AppError("unauthenticated", "This endpoint requires the scheduler credential.")


@router.get("/api/internal/memory-consolidation", operation_id="opsMemoryConsolidation")
def run_memory_consolidation(
    x_cron_secret: Optional[str] = Header(None, alias="X-Cron-Secret"),
    authorization: Optional[str] = Header(None),
) -> dict[str, Any]:
    """Process queued memory consolidation within the current load policy."""
    _require_scheduler(x_cron_secret, authorization)
    return run_scheduled_consolidation(consolidation)


@router.get("/api/internal/daily", operation_id="opsDailyTasks")
def run_daily_tasks(
    x_cron_secret: Optional[str] = Header(None, alias="X-Cron-Secret"),
    authorization: Optional[str] = Header(None),
) -> dict[str, Any]:
    """Once a day, in daytime for most of MindPal's people: the voice retention
    sweep, then any due check-in notifications. One cron for both keeps within
    the scheduler's job limit."""
    _require_scheduler(x_cron_secret, authorization)
    from backend.domain.operations import run_voice_retention_sweep
    from backend.http.notifications import service as notifications

    return {"ok": True, "retention_removed": run_voice_retention_sweep(), "notifications": notifications.run_daily()}


@router.get("/api/internal/platform-pulse", operation_id="opsPlatformPulse")
def get_platform_pulse(x_support_secret: Optional[str] = Header(None, alias="X-Voice-Support-Secret")) -> dict[str, Any]:
    """Current load level, its drivers, and the aggregated pulse. Support only."""
    if not _secret_matches(x_support_secret or "", get_settings().voice_support_diagnostics_secret.strip()):
        raise AppError("unauthenticated", "Platform pulse requires internal support authorization.")
    return platform_status()
