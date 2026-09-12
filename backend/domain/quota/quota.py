# backend/domain/quota/quota.py — Quota and Idempotency Domain

from __future__ import annotations

from typing import Dict, Any, Optional
from backend.infra.store.store import get_store


class QuotaService:
    """Manages user turn quotas and message idempotency."""

    def __init__(self) -> None:
        self.store = get_store()

    def check_and_consume_quota(self, user_id_hash: str) -> bool:
        doc = self.store.get_document("user_quotas", user_id_hash) or {"used": 0, "limit": 100}
        if doc["used"] >= doc["limit"]:
            return False
        doc["used"] += 1
        self.store.set_document("user_quotas", user_id_hash, doc)
        return True

    def refund_quota(self, user_id_hash: str) -> None:
        doc = self.store.get_document("user_quotas", user_id_hash)
        if doc and doc["used"] > 0:
            doc["used"] -= 1
            self.store.set_document("user_quotas", user_id_hash, doc)

    def get_idempotency_result(self, idempotency_key: str) -> Optional[Dict[str, Any]]:
        if not idempotency_key:
            return None
        return self.store.get_document("idempotency_records", idempotency_key)

    def set_idempotency_result(self, idempotency_key: str, payload: Dict[str, Any]) -> None:
        if idempotency_key:
            self.store.set_document("idempotency_records", idempotency_key, payload)
