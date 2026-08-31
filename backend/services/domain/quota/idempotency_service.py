# backend/services/domain/quota/idempotency_service.py

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass
from typing import Any

from backend.core.errors import AppError
from backend.core.security import sanitize_text
from backend.services.domain.storage import StorageService as DBService


class IdempotencyConflictError(AppError):
    """Raised when a request key is active with a different payload."""

    status_code = 409

    def __init__(
        self,
        message: str = "Idempotent request conflict",
        *,
        code: str = "idempotency_conflict",
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message, code=code, details=details)


@dataclass(frozen=True, slots=True)
class IdempotencyRecord:
    key: str
    user_id_hash: str
    operation: str
    payload_hash: str
    completed: bool
    response: dict[str, Any] | None
    created_at: float
    updated_at: float


class IdempotencyService:
    """Atomic distributed request deduplication."""

    COLLECTION = "idempotency_records"

    def __init__(
        self,
        *,
        db: DBService,
        ttl_seconds: int = 24 * 3600,
        processing_timeout_seconds: int = 30,
    ) -> None:
        self.db = db
        self.ttl_seconds = max(60, int(ttl_seconds))
        self.processing_timeout_seconds = max(5, int(processing_timeout_seconds))

    def payload_hash(self, payload: Any) -> str:
        serialized = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        return hashlib.sha256(serialized.encode("utf-8")).hexdigest()

    async def claim(
        self,
        *,
        user_id_hash: str,
        key: str,
        operation: str,
        payload_hash: str,
    ) -> IdempotencyRecord:
        user_id_hash = sanitize_text(user_id_hash, 160)
        key = sanitize_text(key, 160)
        operation = sanitize_text(operation, 80) or "default"
        payload_hash = sanitize_text(payload_hash, 120)

        record_id = hashlib.sha256(f"{user_id_hash}:{operation}:{key}".encode()).hexdigest()
        now = time.time()
        claimed_record: dict[str, Any] = {}

        def updater(data: dict[str, Any]) -> dict[str, Any]:
            nonlocal claimed_record
            data = dict(data or {})

            if data and data.get("created_at"):
                created_at = float(data.get("created_at") or 0)
                if now - created_at > self.ttl_seconds:
                    data = {}

            if not data:
                payload = {
                    "key": key,
                    "user_id_hash": user_id_hash,
                    "operation": operation,
                    "payload_hash": payload_hash,
                    "completed": False,
                    "response": None,
                    "created_at": now,
                    "updated_at": now,
                }
                claimed_record = payload
                return payload

            existing_hash = str(data.get("payload_hash") or "")
            if existing_hash != payload_hash:
                raise IdempotencyConflictError(
                    "Idempotency key reused with a different payload",
                    details={"key": key, "operation": operation},
                )

            completed = bool(data.get("completed", False))
            if not completed:
                updated_at = float(data.get("updated_at") or 0)
                if now - updated_at > self.processing_timeout_seconds:
                    data["updated_at"] = now

            claimed_record = data
            return data

        await self.db.provider.atomic_update_document(self.COLLECTION, record_id, updater)
        return self._record_from_dict(claimed_record)

    async def complete(
        self,
        *,
        claim: IdempotencyRecord,
        response: dict[str, Any],
    ) -> IdempotencyRecord:
        record_id = hashlib.sha256(f"{claim.user_id_hash}:{claim.operation}:{claim.key}".encode()).hexdigest()
        now = time.time()
        final_dict: dict[str, Any] = {}

        def updater(data: dict[str, Any]) -> dict[str, Any]:
            nonlocal final_dict
            data = dict(data or {})
            data["completed"] = True
            data["response"] = response
            data["updated_at"] = now
            final_dict = data
            return data

        await self.db.provider.atomic_update_document(self.COLLECTION, record_id, updater)
        return self._record_from_dict(final_dict)

    async def fail(self, *, claim: IdempotencyRecord) -> None:
        record_id = hashlib.sha256(f"{claim.user_id_hash}:{claim.operation}:{claim.key}".encode()).hexdigest()
        await self.db.provider.delete_document(self.COLLECTION, record_id)

    @staticmethod
    def _record_from_dict(data: dict[str, Any]) -> IdempotencyRecord:
        return IdempotencyRecord(
            key=str(data.get("key") or ""),
            user_id_hash=str(data.get("user_id_hash") or ""),
            operation=str(data.get("operation") or ""),
            payload_hash=str(data.get("payload_hash") or ""),
            completed=bool(data.get("completed", False)),
            response=data.get("response") if isinstance(data.get("response"), dict) else None,
            created_at=float(data.get("created_at") or 0),
            updated_at=float(data.get("updated_at") or 0),
        )
