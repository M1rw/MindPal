from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from backend.core.errors import AppError
from backend.core.security import sanitize_text
from backend.services.db_service import DBService


class IdempotencyConflictError(AppError):
    status_code = 409
    code = "idempotency_conflict"


@dataclass(frozen=True, slots=True)
class IdempotencyClaim:
    key: str
    owner: bool
    completed: bool
    response: dict[str, Any] | None = None


class IdempotencyService:
    """Atomic request ownership and replay protection for mutation/provider calls."""

    COLLECTION = "idempotency_records"
    MAX_REPLAY_RESPONSE_BYTES = 700_000

    def __init__(self, *, db: DBService, ttl_seconds: int = 24 * 3600, processing_timeout_seconds: int = 120) -> None:
        self.db = db
        self.ttl_seconds = max(300, int(ttl_seconds))
        self.processing_timeout_seconds = max(15, int(processing_timeout_seconds))

    @staticmethod
    def payload_hash(payload: Any) -> str:
        encoded = json.dumps(
            payload,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            default=str,
        ).encode()
        return hashlib.sha256(encoded).hexdigest()

    async def claim(
        self,
        *,
        user_id_hash: str,
        key: str,
        operation: str,
        payload_hash: str,
    ) -> IdempotencyClaim:
        clean_key = sanitize_text(key, 120)
        if not clean_key:
            return IdempotencyClaim(key="", owner=True, completed=False)
        clean_user = sanitize_text(user_id_hash, 120) or "anonymous"
        clean_operation = sanitize_text(operation, 80) or "operation"
        doc_key = hashlib.sha256(f"{clean_user}:{clean_operation}:{clean_key}".encode()).hexdigest()
        now = time.time()
        result: dict[str, Any] = {}

        def updater(data: dict[str, Any]) -> dict[str, Any]:
            nonlocal result
            status = str(data.get("status") or "")
            updated = float(data.get("updated_at") or data.get("created_at") or 0)
            expired = now - updated > self.ttl_seconds
            stalled = status == "processing" and now - updated > self.processing_timeout_seconds
            if data and not expired and not stalled:
                if str(data.get("payload_hash") or "") != payload_hash:
                    result = {"conflict": True}
                    return data
                if status == "completed":
                    response = data.get("response")
                    result = {
                        "owner": False,
                        "completed": True,
                        "response": response if isinstance(response, dict) else None,
                    }
                elif status == "completed_no_replay":
                    result = {"completed_no_replay": True}
                else:
                    result = {"owner": False, "completed": False}
                return data

            record = {
                "user_id_hash": clean_user,
                "operation": clean_operation,
                # Store only a hash of the caller-supplied key. The deterministic
                # document ID already preserves lookup semantics.
                "key_hash": hashlib.sha256(clean_key.encode()).hexdigest(),
                "payload_hash": payload_hash,
                "status": "processing",
                "created_at": now,
                "updated_at": now,
                "expires_at": datetime.fromtimestamp(now + self.ttl_seconds, tz=timezone.utc),
            }
            result = {"owner": True, "completed": False}
            return record

        await self.db.provider.atomic_update_document(self.COLLECTION, doc_key, updater)
        if result.get("conflict"):
            raise IdempotencyConflictError("Idempotency key was reused with a different payload")
        if result.get("completed_no_replay"):
            raise IdempotencyConflictError("This request already completed and cannot be replayed")
        if not result.get("owner") and not result.get("completed"):
            raise IdempotencyConflictError("A request with this idempotency key is already processing")
        return IdempotencyClaim(
            key=doc_key,
            owner=bool(result.get("owner")),
            completed=bool(result.get("completed")),
            response=result.get("response"),
        )

    async def complete(self, *, claim: IdempotencyClaim, response: dict[str, Any]) -> None:
        if not claim.key or not claim.owner:
            return
        now = time.time()
        encoded = json.dumps(response, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8")
        replayable = len(encoded) <= self.MAX_REPLAY_RESPONSE_BYTES
        clean_response = json.loads(encoded.decode("utf-8")) if replayable else None
        response_hash = hashlib.sha256(encoded).hexdigest()
        await self.db.provider.atomic_update_document(
            self.COLLECTION,
            claim.key,
            lambda data: {
                **data,
                "status": "completed" if replayable else "completed_no_replay",
                "response": clean_response,
                "response_hash": response_hash,
                "updated_at": now,
                "expires_at": datetime.fromtimestamp(now + self.ttl_seconds, tz=timezone.utc),
            },
        )

    async def fail(self, *, claim: IdempotencyClaim) -> None:
        if claim.key and claim.owner:
            await self.db.provider.delete_document(self.COLLECTION, claim.key)
