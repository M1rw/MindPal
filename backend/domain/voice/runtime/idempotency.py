from __future__ import annotations

import hashlib
import json
import time
import uuid
from typing import Any, Callable, Dict, Optional

from backend.core.errors import AppError

VOICE_EVENT_PROCESSING_TIMEOUT_S = 60
VOICE_EVENT_RETENTION_S = 24 * 60 * 60


class VoiceEventIdempotency:
    """Claim, complete, and release one voice event at a time."""

    def __init__(self, store: Any, collection: str) -> None:
        self.store = store
        self.collection = collection

    def run(
        self,
        *,
        user_id_hash: str,
        session_id: str,
        key: str,
        payload: Dict[str, Any],
        handler: Callable[[], Dict[str, Any]],
    ) -> Dict[str, Any]:
        key = str(key or "").strip()[:128]
        if not key:
            return handler()

        fingerprint = hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode()
        ).hexdigest()
        record_id = hashlib.sha256(f"{user_id_hash}:{session_id}:{key}".encode()).hexdigest()
        owner_token = uuid.uuid4().hex
        now = time.time()
        claim: dict[str, Any] = {}

        def claim_event(current: Optional[Dict[str, Any]], write: Any) -> dict[str, Any]:
            nonlocal claim
            existing = dict(current or {})
            if existing:
                if existing.get("fingerprint") != fingerprint:
                    raise AppError("conflict", "Idempotency-Key was reused for a different voice event.")
                if existing.get("completed"):
                    claim = existing
                    return existing
                processing_until = float(existing.get("processing_until") or 0)
                if processing_until > now:
                    raise AppError("conflict", "That voice event is already being processed.")
                claim = {
                    **existing,
                    "owner_token": owner_token,
                    "processing_until": now + VOICE_EVENT_PROCESSING_TIMEOUT_S,
                }
                write(claim)
                return claim
            claim = {
                "user_id_hash": user_id_hash,
                "session_id": session_id,
                "key": key,
                "fingerprint": fingerprint,
                "completed": False,
                "created_at": now,
                "owner_token": owner_token,
                "processing_until": now + VOICE_EVENT_PROCESSING_TIMEOUT_S,
                "expires_at": now + VOICE_EVENT_RETENTION_S,
            }
            write(claim)
            return claim

        self.store.transact(self.collection, record_id, claim_event)
        if claim.get("completed"):
            return dict(claim.get("response") or {"ok": True, "deduplicated": True})

        try:
            response = handler()

            def complete_event(current: Optional[Dict[str, Any]], write: Any) -> None:
                if not current or current.get("owner_token") != owner_token:
                    raise AppError("conflict", "That voice event is no longer owned by this request.")
                write({
                    **current,
                    "completed": True,
                    "processing_until": 0,
                    "response": response,
                    "completed_at": time.time(),
                    "expires_at": time.time() + VOICE_EVENT_RETENTION_S,
                })

            self.store.transact(self.collection, record_id, complete_event)
            return response
        except Exception:
            def release_event(current: Optional[Dict[str, Any]], write: Any) -> None:
                if current and current.get("owner_token") == owner_token:
                    write({**current, "processing_until": 0, "failed_at": time.time()})

            try:
                self.store.transact(self.collection, record_id, release_event)
            except Exception:
                pass
            raise
