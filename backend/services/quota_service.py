from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from backend.core.errors import AppError
from backend.core.security import sanitize_text
from backend.services.db_service import DBService


class QuotaExceededError(AppError):
    status_code = 429
    code = "quota_exceeded"


@dataclass(frozen=True, slots=True)
class QuotaSnapshot:
    credits_5h: int
    limit_5h: int
    reset_5h_seconds: int
    credits_week: int
    limit_week: int
    reset_week_seconds: int
    total_messages: int

    def to_dict(self) -> dict[str, int]:
        return {
            "credits_5h": self.credits_5h,
            "limit_5h": self.limit_5h,
            "reset_5h_seconds": self.reset_5h_seconds,
            "credits_week": self.credits_week,
            "limit_week": self.limit_week,
            "reset_week_seconds": self.reset_week_seconds,
            "total_messages": self.total_messages,
        }


@dataclass(frozen=True, slots=True)
class QuotaReservation:
    request_id: str
    user_id_hash: str
    cost: int
    status: str
    snapshot: QuotaSnapshot
    duplicate: bool = False


class QuotaService:
    """Atomic reserve/commit/refund accounting.

    Credits are reserved before any paid operation. A crashed request is
    automatically refunded after ``reservation_ttl_seconds``. Request IDs make
    transitions idempotent while the record is retained.
    """

    COLLECTION = "quota_accounts"

    def __init__(
        self,
        *,
        db: DBService,
        limit_5h: int = 50,
        limit_week: int = 500,
        window_5h_seconds: int = 5 * 3600,
        window_week_seconds: int = 7 * 24 * 3600,
        reservation_ttl_seconds: int = 15 * 60,
    ) -> None:
        self.db = db
        self.limit_5h = max(1, int(limit_5h))
        self.limit_week = max(1, int(limit_week))
        self.window_5h_seconds = max(60, int(window_5h_seconds))
        self.window_week_seconds = max(60, int(window_week_seconds))
        self.reservation_ttl_seconds = max(60, int(reservation_ttl_seconds))

    async def reserve(
        self,
        *,
        user_id_hash: str,
        request_id: str,
        cost: int,
        operation: str,
    ) -> QuotaReservation:
        user_id_hash = sanitize_text(user_id_hash, 120)
        request_id = sanitize_text(request_id, 120)
        operation = sanitize_text(operation, 80) or "unknown"
        if not user_id_hash or not request_id:
            raise ValueError("user_id_hash and request_id are required")
        cost = max(1, int(cost))
        now = time.time()
        result: dict[str, Any] = {}

        def updater(data: dict[str, Any]) -> dict[str, Any]:
            nonlocal result
            account = self._normalized_account(data, now)
            reservations = dict(account.get("reservations") or {})
            existing = reservations.get(request_id)

            if isinstance(existing, dict):
                status = str(existing.get("status") or "reserved")
                # Refunded/expired operations are safe to retry and must reserve
                # again; treating them as duplicates would create a free call.
                if status in {"reserved", "committed"}:
                    result = {
                        "status": status,
                        "cost": int(existing.get("cost") or cost),
                        "duplicate": True,
                        "account": account,
                    }
                    return account
                reservations.pop(request_id, None)

            if account["credits_5h"] + cost > self.limit_5h or account["credits_week"] + cost > self.limit_week:
                account["reservations"] = reservations
                account["updated_at"] = now
                result = {"status": "denied", "cost": cost, "duplicate": False, "account": account}
                return account

            account["credits_5h"] += cost
            account["credits_week"] += cost
            reservations[request_id] = {
                "status": "reserved",
                "cost": cost,
                "operation": operation,
                "created_at": now,
                "updated_at": now,
                "window_5h_started_at": account["window_5h_started_at"],
                "window_week_started_at": account["window_week_started_at"],
            }
            account["reservations"] = self._prune_reservations(reservations, now)
            account["updated_at"] = now
            result = {"status": "reserved", "cost": cost, "duplicate": False, "account": account}
            return account

        await self.db.provider.atomic_update_document(self.COLLECTION, user_id_hash, updater)
        account = result["account"]
        snapshot = self._snapshot(account, now)
        if result["status"] == "denied":
            raise QuotaExceededError(
                "Usage limit reached",
                details={"usage": snapshot.to_dict(), "request_id": request_id},
            )
        return QuotaReservation(
            request_id=request_id,
            user_id_hash=user_id_hash,
            cost=int(result["cost"]),
            status=str(result["status"]),
            snapshot=snapshot,
            duplicate=bool(result["duplicate"]),
        )

    async def commit(self, *, user_id_hash: str, request_id: str) -> QuotaSnapshot:
        return await self._transition(user_id_hash=user_id_hash, request_id=request_id, target="committed")

    async def refund(self, *, user_id_hash: str, request_id: str) -> QuotaSnapshot:
        return await self._transition(user_id_hash=user_id_hash, request_id=request_id, target="refunded")

    async def get_snapshot(self, *, user_id_hash: str) -> QuotaSnapshot:
        user_id_hash = sanitize_text(user_id_hash, 120)
        now = time.time()
        normalized: dict[str, Any] = {}

        def updater(data: dict[str, Any]) -> dict[str, Any]:
            nonlocal normalized
            normalized = self._normalized_account(data, now)
            normalized["updated_at"] = now
            return normalized

        await self.db.provider.atomic_update_document(self.COLLECTION, user_id_hash, updater)
        return self._snapshot(normalized, now)

    async def _transition(self, *, user_id_hash: str, request_id: str, target: str) -> QuotaSnapshot:
        user_id_hash = sanitize_text(user_id_hash, 120)
        request_id = sanitize_text(request_id, 120)
        now = time.time()
        result: dict[str, Any] = {}

        def updater(data: dict[str, Any]) -> dict[str, Any]:
            nonlocal result
            account = self._normalized_account(data, now)
            reservations = dict(account.get("reservations") or {})
            item = reservations.get(request_id)
            if not isinstance(item, dict):
                result = {"account": account}
                return account

            current_status = str(item.get("status") or "reserved")
            cost = max(1, int(item.get("cost") or 1))
            if target == "committed" and current_status == "reserved":
                item["status"] = "committed"
                account["total_messages"] += 1
            elif target == "refunded" and current_status == "reserved":
                item["status"] = "refunded"
                self._refund_for_record(account, item, cost)
            item["updated_at"] = now
            reservations[request_id] = item
            account["reservations"] = self._prune_reservations(reservations, now)
            account["updated_at"] = now
            result = {"account": account}
            return account

        await self.db.provider.atomic_update_document(self.COLLECTION, user_id_hash, updater)
        return self._snapshot(result.get("account") or {}, now)

    def _normalized_account(self, data: dict[str, Any], now: float) -> dict[str, Any]:
        account = dict(data or {})
        start_5h = float(account.get("window_5h_started_at") or now)
        start_week = float(account.get("window_week_started_at") or now)
        credits_5h = max(0, int(account.get("credits_5h") or 0))
        credits_week = max(0, int(account.get("credits_week") or 0))

        if now - start_5h >= self.window_5h_seconds:
            start_5h = now
            credits_5h = 0
        if now - start_week >= self.window_week_seconds:
            start_week = now
            credits_week = 0

        account.update(
            {
                "window_5h_started_at": start_5h,
                "window_week_started_at": start_week,
                "credits_5h": credits_5h,
                "credits_week": credits_week,
                "total_messages": max(0, int(account.get("total_messages") or 0)),
            }
        )

        reservations = dict(account.get("reservations") or {})
        kept: dict[str, Any] = {}
        for key, value in reservations.items():
            if not isinstance(value, dict):
                continue
            created_at = float(value.get("created_at") or value.get("updated_at") or 0)
            status = str(value.get("status") or "reserved")
            if status == "reserved" and now - created_at >= self.reservation_ttl_seconds:
                self._refund_for_record(account, value, max(1, int(value.get("cost") or 1)))
                continue
            updated_at = float(value.get("updated_at") or created_at)
            if now - updated_at < self.reservation_ttl_seconds:
                kept[sanitize_text(str(key), 120)] = value

        account["reservations"] = self._cap_reservations(kept)
        return account

    def _refund_for_record(self, account: dict[str, Any], item: dict[str, Any], cost: int) -> None:
        if float(item.get("window_5h_started_at") or -1) == float(account.get("window_5h_started_at") or -2):
            account["credits_5h"] = max(0, int(account.get("credits_5h") or 0) - cost)
        if float(item.get("window_week_started_at") or -1) == float(account.get("window_week_started_at") or -2):
            account["credits_week"] = max(0, int(account.get("credits_week") or 0) - cost)

    def _prune_reservations(self, reservations: dict[str, Any], now: float) -> dict[str, Any]:
        kept = {
            sanitize_text(str(key), 120): value
            for key, value in reservations.items()
            if isinstance(value, dict)
            and now - float(value.get("updated_at") or value.get("created_at") or 0) < self.reservation_ttl_seconds
        }
        return self._cap_reservations(kept)

    @staticmethod
    def _cap_reservations(reservations: dict[str, Any]) -> dict[str, Any]:
        if len(reservations) <= 1000:
            return reservations
        return dict(
            sorted(
                reservations.items(),
                key=lambda item: float(item[1].get("updated_at") or item[1].get("created_at") or 0),
                reverse=True,
            )[:1000]
        )

    def _snapshot(self, account: dict[str, Any], now: float) -> QuotaSnapshot:
        account = self._normalized_account(account, now)
        return QuotaSnapshot(
            credits_5h=account["credits_5h"],
            limit_5h=self.limit_5h,
            reset_5h_seconds=max(0, int(account["window_5h_started_at"] + self.window_5h_seconds - now)),
            credits_week=account["credits_week"],
            limit_week=self.limit_week,
            reset_week_seconds=max(0, int(account["window_week_started_at"] + self.window_week_seconds - now)),
            total_messages=account["total_messages"],
        )
