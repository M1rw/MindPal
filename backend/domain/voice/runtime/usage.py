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


# How many settled session ids a day's usage document remembers. A day holds at
# most daily_cap / min_session calls, far fewer than this.
_SETTLED_IDS_KEPT = 200


def utc_day(epoch: float | None = None) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(epoch if epoch is not None else time.time()))


def charged_day(record: Dict[str, Any]) -> str:
    """The usage day a session's hold was charged to (older rows: their mint day)."""
    day = record.get("charged_day")
    if isinstance(day, str) and day:
        return day
    created = record.get("created_at")
    return utc_day(float(created)) if isinstance(created, (int, float)) else utc_day()


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

        def hold(current: Any, write: Any) -> tuple[int, int, str]:
            usage = self.normalize_usage(current, user_id_hash)
            used = int(usage.get("used_s") or 0)
            available = max(0, self.daily_cap_seconds - used)
            if available < self.min_session_seconds:
                return 0, available, usage["day"]
            held = min(self.reserve_seconds, available)
            usage["used_s"] = used + held
            write(usage)
            return held, available, usage["day"]

        try:
            reserved, remaining, day = self.store.transact(self.usage_collection, user_id_hash, hold)
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
        return {"reserved_s": reserved, "remaining_s": remaining, "day": day}

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
        """Clear the pointer only if it still names this session.

        Read-then-delete could remove a newer call's pointer that was written in
        between (a reclaim racing a fresh mint), leaving that call unreclaimable.
        """

        def release(current: Any, write: Any) -> None:
            if isinstance(current, dict) and current.get("session_id") == session_id:
                write({"user_id_hash": user_id_hash, "session_id": "", "cleared_at": time.time()})

        try:
            self.store.transact(self.active_collection, user_id_hash, release)
        except StoreUnavailable:
            logger.warning("voice_active_clear_failed_store_unavailable")

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

    def refund(
        self,
        user_id_hash: str,
        seconds: int,
        *,
        reason: str,
        settlement_id: str = "",
        charged_day: str = "",
    ) -> bool | None:
        """Give seconds back to the day they were charged to, at most once per settlement.

        Returns True when applied, False when there was nothing to apply (already
        refunded, or the charge belonged to a day that has since rolled over:
        subtracting it from today's counter would hand out time the caller never
        paid for), and None when storage was unavailable.
        """
        if seconds <= 0:
            return False

        def give_back(current: Any, write: Any) -> bool:
            usage = self.normalize_usage(current, user_id_hash)
            if charged_day and usage["day"] != charged_day:
                return False
            settled = list(usage.get("settled") or [])
            if settlement_id:
                if settlement_id in settled:
                    return False
                settled = (settled + [settlement_id])[-_SETTLED_IDS_KEPT:]
                usage["settled"] = settled
            usage["used_s"] = max(0, int(usage.get("used_s") or 0) - seconds)
            write(usage)
            return True

        try:
            applied = self.store.transact(self.usage_collection, user_id_hash, give_back)
        except StoreUnavailable:
            logger.error("voice_refund_failed_store_unavailable seconds=%s reason=%s", seconds, reason[:40])
            return None
        if applied:
            logger.info("voice_seconds_refunded user_present=1 seconds=%s reason=%s", seconds, reason)
        return applied

    @staticmethod
    def normalize_usage(usage: Any, user_id_hash: str) -> Dict[str, Any]:
        day = utc_day()
        if not isinstance(usage, dict) or usage.get("day") != day:
            return {"user_id_hash": user_id_hash, "day": day, "used_s": 0}
        return dict(usage)

    def usage(self, user_id_hash: str) -> Dict[str, Any]:
        return self.normalize_usage(
            self.store.get_document(self.usage_collection, user_id_hash), user_id_hash
        )