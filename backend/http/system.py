# backend/http/system.py — Thin HTTP adapter for system route catalog

from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Query

from backend.core.contract import iter_operations
from backend.domain.identity.identity import UserSession, account_guard

router = APIRouter()


@router.get("/api/system/route-catalog", operation_id="systemRouteCatalog")
def get_route_catalog(
    ai_access: Optional[str] = Query(None, max_length=40),
    session: UserSession = Depends(account_guard("view the API route catalog")),
) -> Dict[str, Any]:
    """The full API surface, including operations that are not yet live.

    Signed-in only. Handing an unauthenticated caller a map of every endpoint,
    its owner, audience and side-effect flag is free reconnaissance — it names
    the routes worth probing and says which of them mutate state.
    """
    operations = list(iter_operations())
    if ai_access:
        operations = [op for op in operations if op.get("x_mindpal", {}).get("ai-access") == ai_access]

    return {
        "current_user_id_hash": session.user_id_hash,
        "total_operations": len(operations),
        "operations": operations,
    }
