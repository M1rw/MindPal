from __future__ import annotations

import hmac
from typing import Any, Optional

from fastapi import APIRouter, Header, Query

from backend.configs.settings import get_settings
from backend.core.errors import AppError
from backend.domain.identity.identity import verify_auth_header
from backend.domain.voice.contracts.requests import VoiceDiagnosticsRequest
from backend.domain.voice.analytics import VoiceAnalyticsService
from backend.http.voice import session_service
from backend.domain.voice.contracts.responses import VoiceAnalyticsResponse, VoiceAuditResponse, VoiceUsageResponse
from backend.tools.voice_diagnostics import load_voice_diagnostics, persist_voice_diagnostics
from backend.tools.voice_retention import run_voice_retention

router = APIRouter()


def _secret_matches(presented: str, configured: str) -> bool:
    """Constant-time comparison; an unset secret never matches."""
    return bool(configured) and bool(presented) and hmac.compare_digest(presented.encode(), configured.encode())
analytics_service = VoiceAnalyticsService(store=session_service.store)


@router.get("/api/voice/usage", operation_id="voiceGetUsage", response_model=VoiceUsageResponse)
def get_voice_usage(authorization: Optional[str] = Header(None)) -> dict[str, Any]:
    session = verify_auth_header(authorization)
    if not session.is_authenticated:
        raise AppError("unauthenticated", "Live voice usage requires a signed-in account.")
    return session_service.usage_snapshot(user_id_hash=session.user_id_hash)


@router.get("/api/voice/analytics", operation_id="voiceGetSessionAnalytics", response_model=VoiceAnalyticsResponse)
def get_voice_session_analytics(session_id: str = Query(..., min_length=1, max_length=64), authorization: Optional[str] = Header(None)) -> dict[str, Any]:
    session = verify_auth_header(authorization)
    if not session.is_authenticated:
        raise AppError("unauthenticated", "Live voice analytics requires a signed-in account.")
    return analytics_service.summarize_session(session.user_id_hash, session_id)


@router.get("/api/voice/audit", operation_id="voiceGetSessionAudit", response_model=VoiceAuditResponse)
def get_voice_session_audit(session_id: str = Query(..., min_length=1, max_length=64), authorization: Optional[str] = Header(None)) -> dict[str, Any]:
    session = verify_auth_header(authorization)
    if not session.is_authenticated:
        raise AppError("unauthenticated", "Live voice audit requires a signed-in account.")
    return analytics_service.audit_session(session.user_id_hash, session_id)


@router.get("/api/internal/voice-retention", operation_id="voiceRetentionSweep")
def voice_retention_sweep(
    x_cron_secret: Optional[str] = Header(None, alias="X-Cron-Secret"),
    authorization: Optional[str] = Header(None),
) -> dict[str, Any]:
    bearer = authorization.removeprefix("Bearer ").strip() if authorization else ""
    presented = [value for value in (x_cron_secret or "", bearer) if value]
    if not any(_secret_matches(value, secret) for value in presented for secret in get_settings().scheduler_secrets()):
        raise AppError("unauthenticated", "Voice retention requires the scheduler credential.")
    return {"ok": True, "removed": run_voice_retention()}


@router.post("/api/internal/voice-diagnostics", operation_id="voiceSubmitDiagnostics")
def submit_voice_diagnostics(
    payload: VoiceDiagnosticsRequest,
    x_support_secret: Optional[str] = Header(None, alias="X-Voice-Support-Secret"),
) -> dict[str, Any]:
    configured = get_settings().voice_support_diagnostics_secret.strip()
    if not _secret_matches(x_support_secret or "", configured):
        raise AppError("unauthenticated", "Voice diagnostics require internal support authorization.")
    return persist_voice_diagnostics(payload.session_id, payload.trace)


@router.get("/api/internal/voice-diagnostics/{session_id}", operation_id="voiceReviewDiagnostics")
def review_voice_diagnostics_route(
    session_id: str,
    x_support_secret: Optional[str] = Header(None, alias="X-Voice-Support-Secret"),
) -> dict[str, Any]:
    configured = get_settings().voice_support_diagnostics_secret.strip()
    if not _secret_matches(x_support_secret or "", configured):
        raise AppError("unauthenticated", "Voice diagnostics require internal support authorization.")
    return load_voice_diagnostics(session_id)
