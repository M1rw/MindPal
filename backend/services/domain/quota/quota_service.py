# backend/services/domain/quota/quota_service.py

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass
from typing import Any

from backend.core.errors import AppError
from backend.core.security import sanitize_text
from backend.core.validation import validate_quota_request
from backend.services.domain.storage import StorageService as DBService


class QuotaExceededError(AppError):
    """Raised when a user attempts to consume credits beyond the allowed window."""

    status_code = 429

    def __init__(
        self,
        message: str = "Quota limit exceeded",
        *,
        code: str = "quota_limit_exceeded",
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message, code=code, details=details)


@dataclass(frozen=True, slots=True)
class QuotaDecision:
    allowed: bool
    cost: int
    credits_5h: int
    limit_5h: int
    reset_5h_seconds: int
    credits_week: int
    limit_week: int
    reset_week_seconds: int
    total_messages: int

    def to_dict(self) -> dict[str, int | bool]:
        return {
            "allowed": self.allowed,
            "cost": self.cost,
            "credits_5h": self.credits_5h,
            "limit_5h": self.limit_5h,
            "reset_5h_seconds": self.reset_5h_seconds,
            "credits_week": self.credits_week,
            "limit_week": self.limit_week,
            "reset_week_seconds": self.reset_week_seconds,
            "total_messages": self.total_messages,
        }


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


class QuotaService:
    """Atomic multi-window credit accounting stored in user account documents."""

    COLLECTION = "user_accounts"

    def __init__(
        self,
        *,
        db: DBService,
        limit_5h: int = 10,
        limit_week: int = 100,
        window_5h_seconds: int = 5 * 3600,
        window_week_seconds: int = 7 * 24 * 3600,
        reservation_ttl_seconds: int = 120,
    ) -> None:
        self.db = db
        self.limit_5h = max(1, int(limit_5h))
        self.limit_week = max(1, int(limit_week))
        self.window_5h_seconds = max(60, int(window_5h_seconds))
        self.window_week_seconds = max(3600, int(window_week_seconds))
        self.reservation_ttl_seconds = max(10, int(reservation_ttl_seconds))

    async def reserve(
        self,
        *,
        user_id_hash: str,
        request_id: str,
        cost: int = 1,
        operation: str = "chat",
    ) -> QuotaDecision:
        user_id_hash = sanitize_text(user_id_hash, 160)
        request_id = sanitize_text(request_id, 160)
        operation = sanitize_text(operation, 80) or "chat"
        cost = max(1, int(cost))
        validate_quota_request(user_id_hash, request_id, cost)
        now = time.time()
        result: dict[str, Any] = {}

        def updater(data: dict[str, Any]) -> dict[str, Any]:
            nonlocal result
            account = self._normalized_account(data, now)
            active_reservations = self._prune_reservations(account.get("reservations"), now)

            pending_cost = sum(res["cost"] for res in active_reservations)
            projected_5h = account["credits_5h"] + pending_cost + cost
            projected_week = account["credits_week"] + pending_cost + cost

            allowed_5h = projected_5h <= self.limit_5h
            allowed_week = projected_week <= self.limit_week
            allowed = allowed_5h and allowed_week

            if allowed:
                active_reservations.append(
                    {
                        "request_id": request_id,
                        "cost": cost,
                        "operation": operation,
                        "created_at": now,
                        "expires_at": now + self.reservation_ttl_seconds,
                    }
                )

            account["reservations"] = active_reservations
            account["updated_at"] = now
            result = {
                "allowed": allowed,
                "account": account,
                "allowed_5h": allowed_5h,
                "allowed_week": allowed_week,
            }
            return account

        await self.db.provider.atomic_update_document(self.COLLECTION, user_id_hash, updater)
        snapshot = self._snapshot(result["account"], now)
        decision = QuotaDecision(
            allowed=bool(result["allowed"]),
            cost=cost,
            credits_5h=snapshot.credits_5h,
            limit_5h=snapshot.limit_5h,
            reset_5h_seconds=snapshot.reset_5h_seconds,
            credits_week=snapshot.credits_week,
            limit_week=snapshot.limit_week,
            reset_week_seconds=snapshot.reset_week_seconds,
            total_messages=snapshot.total_messages,
        )

        if not decision.allowed:
            code = "quota_5h_exceeded" if not result["allowed_5h"] else "quota_week_exceeded"
            retry_after = (
                decision.reset_5h_seconds
                if not result["allowed_5h"]
                else decision.reset_week_seconds
            )
            raise QuotaExceededError(
                "Usage limit reached for this period",
                code=code,
                details={
                    "user_id_hash": user_id_hash,
                    "request_id": request_id,
                    "retry_after_seconds": max(1, retry_after),
                    "usage": snapshot.to_dict(),
                },
            )

        return decision

    async def commit(
        self,
        *,
        user_id_hash: str,
        request_id: str,
    ) -> QuotaSnapshot:
        user_id_hash = sanitize_text(user_id_hash, 160)
        request_id = sanitize_text(request_id, 160)
        now = time.time()
        result_account: dict[str, Any] = {}

        def updater(data: dict[str, Any]) -> dict[str, Any]:
            nonlocal result_account
            account = self._normalized_account(data, now)
            reservations = account.get("reservations") or []
            match = next((res for res in reservations if res.get("request_id") == request_id), None)

            remaining_reservations = [res for res in reservations if res.get("request_id") != request_id]
            account["reservations"] = self._prune_reservations(remaining_reservations, now)

            if match:
                cost = max(1, int(match.get("cost", 1)))
                account["credits_5h"] += cost
                account["credits_week"] += cost
                account["total_messages"] += 1
                account["last_message_at"] = now

            account["updated_at"] = now
            result_account = account
            return account

        await self.db.provider.atomic_update_document(self.COLLECTION, user_id_hash, updater)
        return self._snapshot(result_account, now)

    async def refund(
        self,
        *,
        user_id_hash: str,
        request_id: str,
    ) -> QuotaSnapshot:
        user_id_hash = sanitize_text(user_id_hash, 160)
        request_id = sanitize_text(request_id, 160)
        now = time.time()
        result_account: dict[str, Any] = {}

        def updater(data: dict[str, Any]) -> dict[str, Any]:
            nonlocal result_account
            account = self._normalized_account(data, now)
            reservations = account.get("reservations") or []
            account["reservations"] = self._prune_reservations(
                [res for res in reservations if res.get("request_id") != request_id],
                now,
            )
            account["updated_at"] = now
            result_account = account
            return account

        await self.db.provider.atomic_update_document(self.COLLECTION, user_id_hash, updater)
        return self._snapshot(result_account, now)

    async def snapshot(self, user_id_hash: str) -> QuotaSnapshot:
        user_id_hash = sanitize_text(user_id_hash, 160)
        data = await self.db.provider.get_document(self.COLLECTION, user_id_hash) or {}
        return self._snapshot(data, time.time())

    def _normalized_account(self, data: dict[str, Any], now: float) -> dict[str, Any]:
        data = dict(data or {})
        window_5h_started_at = float(data.get("window_5h_started_at") or now)
        window_week_started_at = float(data.get("window_week_started_at") or now)

        credits_5h = max(0, int(data.get("credits_5h") or 0))
        credits_week = max(0, int(data.get("credits_week") or 0))

        if now - window_5h_started_at >= self.window_5h_seconds:
            window_5h_started_at = now
            credits_5h = 0

        if now - window_week_started_at >= self.window_week_seconds:
            window_week_started_at = now
            credits_week = 0

        return {
            "user_id_hash": data.get("user_id_hash") or "",
            "window_5h_started_at": window_5h_started_at,
            "window_week_started_at": window_week_started_at,
            "credits_5h": credits_5h,
            "credits_week": credits_week,
            "total_messages": max(0, int(data.get("total_messages") or 0)),
            "reservations": data.get("reservations") or [],
            "created_at": float(data.get("created_at") or now),
            "updated_at": float(data.get("updated_at") or now),
        }

    @staticmethod
    def _prune_reservations(raw_reservations: Any, now: float) -> list[dict[str, Any]]:
        if not isinstance(raw_reservations, list):
            return []

        active: list[dict[str, Any]] = []
        for item in raw_reservations:
            if not isinstance(item, dict):
                continue
            expires_at = float(item.get("expires_at") or 0)
            if expires_at > now:
                active.append(item)

        return (
            sorted(
                active,
                key=lambda item: float(item.get("created_at") or 0),
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
