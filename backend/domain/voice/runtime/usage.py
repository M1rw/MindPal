from __future__ import annotations

import logging
import time
from typing import Any, Callable, Dict

from backend.core.errors import AppError
from backend.infra.store.store import StoreUnavailable
from backend.infra.observability.metrics import VoiceMetric, voice_metrics

logger = logging.getLogger("mindpal.voice")

RECLAIM_REASONS = frozenset(
    {"expired_reclaim", "abandoned_unwarmed", "abandoned_stale", "reclaimed", "client_recover"}
)


class VoiceUsageLifecycle:
    """Own daily voice holds, active-session reclaim, timing, and refunds."""

    def __init__(
        self,
        *,
        store: Any,
        session_collection: str,
        usage_collection: str,
        active_collection: str,
        reserve_seconds: int,
        daily_cap_seconds: int,
        min_session_seconds: int,
        abandoned_unwarmed_seconds: int,
        safety_verified: Callable[[Dict[str, Any]], bool],
        teardown: Callable[..., Dict[str, Any]],
    ) -> None:
        self.store = store
        self.session_collection = session_collection
        self.usage_collection = usage_collection
        self.active_collection = active_collection
        self.reserve_seconds = reserve_seconds
        self.daily_cap_seconds = daily_cap_seconds
        self.min_session_seconds = min_session_seconds
        self.abandoned_unwarmed_seconds = abandoned_unwarmed_seconds
        self.safety_verified = safety_verified
        self.teardown = teardown

    def usage_snapshot(self, user_id_hash: str) -> Dict[str, Any]:
        usage = self.usage(user_id_hash)
        used = max(0, int(usage.get("used_s") or 0))
        active = self.store.get_document(self.active_collection, user_id_hash) or {}
        session_id = str(active.get("session_id") or "")
        in_call = False
        if session_id:
            record = self.store.get_document(self.session_collection, session_id) or {}
            live = record.get("status") not in {None, "torn_down"}
            in_call = live and self.elapsed_s(record) < int(record.get("reserved_s") or 0)
            if in_call:
                used -= self.unspent_hold_s(record)
        used = max(0, used)
        return {
            "used_s": min(used, self.daily_cap_seconds),
            "cap_s": self.daily_cap_seconds,
            "remaining_s": max(0, self.daily_cap_seconds - used),
            "reserve_s": self.reserve_seconds,
            "in_call": in_call,
            "day": str(usage.get("day") or ""),
        }

    def unspent_hold_s(self, record: Dict[str, Any]) -> int:
        reserved = int(record.get("reserved_s") or 0)
        if reserved <= 0:
            return 0
        return max(0, reserved - min(self.elapsed_s(record), reserved))

    def reserve_seconds_for(self, user_id_hash: str) -> Dict[str, int]:
        self.reclaim_active_for_mint(user_id_hash)

        def hold(current: Any, write: Any) -> tuple[int, int]:
            usage = self.normalize_usage(current, user_id_hash)
            used = int(usage.get("used_s") or 0)
            available = max(0, self.daily_cap_seconds - used)
            if available < self.min_session_seconds:
                return 0, available
            held = min(self.reserve_seconds, available)
            usage["used_s"] = used + held
            write(usage)
            return held, available

        try:
            reserved, remaining = self.store.transact(self.usage_collection, user_id_hash, hold)
        except StoreUnavailable as exc:
            voice_metrics().record(VoiceMetric(operation="mint", duration_ms=0, outcome="unavailable", status_code=503))
            logger.error("voice_reserve_denied_store_unavailable user_present=1")
            raise AppError(
                "unavailable",
                "Live voice is briefly unavailable. Please try again in a moment, or use dictation or text.",
            ) from exc
        if not reserved:
            voice_metrics().record(VoiceMetric(operation="mint", duration_ms=0, outcome="quota_exceeded", status_code=429))
            raise AppError(
                "quota_exceeded",
                "Today's live voice minutes are used up. Chat credits do not cover a live call. Try dictation or text.",
            )
        return {"reserved_s": reserved, "remaining_s": remaining}

    def reclaim_active_for_mint(self, user_id_hash: str) -> None:
        active = self.store.get_document(self.active_collection, user_id_hash)
        session_id = str((active or {}).get("session_id") or "")
        if not session_id:
            return
        existing = self.store.get_document(self.session_collection, session_id)
        if not existing or existing.get("status") == "torn_down":
            self.store.delete_document(self.active_collection, user_id_hash)
            return
        if existing.get("user_id_hash") != user_id_hash:
            self.store.delete_document(self.active_collection, user_id_hash)
            return
        reason = self.reclaim_reason(existing)
        logger.info("voice_session_reclaim session_id=%s reason=%s", session_id, reason)
        self.teardown(user_id_hash=user_id_hash, session_id=session_id, reason=reason, used_s=0)

    def reclaim_reason(self, record: Dict[str, Any]) -> str:
        elapsed = self.elapsed_s(record)
        reserved = int(record.get("reserved_s") or self.reserve_seconds)
        if elapsed >= reserved:
            return "expired_reclaim"
        warmed = bool(record.get("setup_complete"))
        if not warmed and elapsed >= self.abandoned_unwarmed_seconds:
            return "abandoned_unwarmed"
        if warmed and not self.safety_verified(record) and elapsed >= self.abandoned_unwarmed_seconds:
            return "abandoned_stale"
        return "reclaimed"

    def clear_active(self, user_id_hash: str, session_id: str) -> None:
        active = self.store.get_document(self.active_collection, user_id_hash)
        if active and active.get("session_id") == session_id:
            self.store.delete_document(self.active_collection, user_id_hash)

    @staticmethod
    def elapsed_s(record: Dict[str, Any]) -> int:
        started = record.get("created_at")
        if not isinstance(started, (int, float)):
            return 0
        return max(0, int(time.time() - float(started)))

    @staticmethod
    def observed_elapsed_s(record: Dict[str, Any]) -> int:
        started = record.get("created_at")
        if not isinstance(started, (int, float)):
            return 0
        latest = float(started)
        for key in ("last_safety_at", "last_classify_at", "last_event_at"):
            value = record.get(key)
            if isinstance(value, (int, float)) and float(value) > latest:
                latest = float(value)
        return max(0, int(latest - float(started)))

    def refund(self, user_id_hash: str, seconds: int, *, reason: str) -> None:
        if seconds <= 0:
            return

        def give_back(current: Any, write: Any) -> None:
            usage = self.normalize_usage(current, user_id_hash)
            usage["used_s"] = max(0, int(usage.get("used_s") or 0) - seconds)
            write(usage)

        try:
            self.store.transact(self.usage_collection, user_id_hash, give_back)
        except StoreUnavailable:
            logger.error("voice_refund_failed_store_unavailable seconds=%s reason=%s", seconds, reason[:40])
            return
        logger.info("voice_seconds_refunded user_present=1 seconds=%s reason=%s", seconds, reason)

    @staticmethod
    def normalize_usage(usage: Any, user_id_hash: str) -> Dict[str, Any]:
        day = time.strftime("%Y-%m-%d", time.gmtime())
        if not isinstance(usage, dict) or usage.get("day") != day:
            return {"user_id_hash": user_id_hash, "day": day, "used_s": 0}
        return dict(usage)

    def usage(self, user_id_hash: str) -> Dict[str, Any]:
        return self.normalize_usage(
            self.store.get_document(self.usage_collection, user_id_hash), user_id_hash
        )