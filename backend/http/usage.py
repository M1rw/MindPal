# backend/http/usage.py — Read-only chat credit snapshot for the Usage screen

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Header, Request

from backend.domain.identity.identity import verify_auth_header
from backend.domain.quota.quota import QuotaService, peer_network_id
from backend.core.storage import get_store

router = APIRouter(tags=["usage"])


@router.get("/api/usage", operation_id="usageGetSnapshot")
def get_usage(request: Request, authorization: Optional[str] = Header(None)) -> dict[str, Any]:
    """The same numbers the chat stream reports after a turn, without spending
    a credit, so the Usage screen is accurate before the first message and
    right after signing in or out. Signed out, it is the per-network window."""
    session = verify_auth_header(authorization)
    quota = QuotaService(get_store())
    if session.has_account_storage:
        decision = quota.snapshot(session.user_id_hash)
    else:
        decision = quota.snapshot_anonymous(peer_network_id(request))
    return {"chat": decision.as_usage()}
