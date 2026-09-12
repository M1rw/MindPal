# backend/http/system.py — Thin HTTP adapter for system route catalog

from __future__ import annotations

from typing import Dict, Any, Optional
from fastapi import APIRouter, Header, Query

from backend.core.contract import iter_operations
from backend.domain.identity.identity import verify_auth_header

router = APIRouter()


@router.get("/api/system/route-catalog", operation_id="systemRouteCatalog")
def get_route_catalog(
    ai_access: Optional[str] = Query(None),
    authorization: Optional[str] = Header(None),
) -> Dict[str, Any]:
    session = verify_auth_header(authorization)
    operations = list(iter_operations())
    if ai_access:
        operations = [op for op in operations if op.get("x_mindpal", {}).get("ai-access") == ai_access]

    return {
        "current_user_id_hash": session.user_id_hash,
        "total_operations": len(operations),
        "operations": operations,
    }
