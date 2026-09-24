# backend/domain/quota/quota.py — Chat credit windows and idempotency

from __future__ import annotations

import hashlib
import json
import logging
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional

from backend.configs.runtime import quota_config
from backend.core.errors import AppError
from backend.infra.store.store import StoreUnavailable, get_store

logger = logging.getLogger("mindpal.quota")

_QUOTA_CONFIG = quota_config()
WINDOW_5H_SECONDS = int(_QUOTA_CONFIG["windows"]["five_hours_seconds"])
WINDOW_WEEK_SECONDS = int(_QUOTA_CONFIG["windows"]["week_seconds"])
LIMIT_5H = int(_QUOTA_CONFIG["limits"]["user_five_hours"])
LIMIT_WEEK = int(_QUOTA_CONFIG["limits"]["user_week"])
ANON_LIMIT_5H = int(_QUOTA_CONFIG["limits"]["anonymous_five_hours"])
ANON_LIMIT_WEEK = int(_QUOTA_CONFIG["limits"]["anonymous_week"])
COST_STANDARD = int(_QUOTA_CONFIG["costs"]["standard"])
COST_PRO = int(_QUOTA_CONFIG["costs"]["pro"])

USER_QUOTA_COLLECTION = "user_quotas"
ANON_RATE_COLLECTION = "anon_rate_limits"
SHARED_ANON_SUBJECTS = frozenset(_QUOTA_CONFIG["anonymous_subjects"])


def _anonymous_load_scale() -> float:
    try:
        from backend.domain.dynamic.policy import policy

        return float(policy("quota")["anonymous_scale"])
    except Exception:
        return 1.0


def cost_for_model(model: str | None) -> int:
    return COST_PRO if str(model or "").strip().lower() == "pro" else COST_STANDARD


def is_user_quota_subject(user_id_hash: str | None) -> bool:
    """Signed-in account keys only. The shared guest identity is not a user bucket."""
    key = str(user_id_hash or "").strip()
    if not key:
        return False
    lowered = key.lower()
    if lowered in SHARED_ANON_SUBJECTS:
        return False
    if lowered.startswith("usr_anon") or lowered.startswith("anon_ip_"):
        return False
    return True


def normalize_peer(peer: str | None) -> str:
    host = str(peer or "").strip().lower()
    if host.startswith("::ffff:"):
        host = host[7:]
    return host or "unknown"


def anonymous_quota_key(peer: str | None) -> str:
    """Hashed TCP peer. Not a client-supplied device id and not usr_anon_default."""
    digest = hashlib.sha256(f"mindpal-anon-ip:{normalize_peer(peer)}".encode("utf-8")).hexdigest()[:32]
    return f"anon_ip_{digest}"


def peer_network_id(request: Any) -> str:
    """Address the server accepted for this connection.

    Do not read X-Forwarded-For or a guest device header here. Those are
    client-supplied. Behind a reverse proxy, enable trusted proxy headers so
    the ASGI server sets request.client.host from the proxy.
    """
    client = getattr(request, "client", None)
    return normalize_peer(getattr(client, "host", None))


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
    scope: str = "account"
    # Which windows this charge landed in (their reset timestamps). A refund
    # goes back to these windows only; see QuotaService._refund.
    window_5h: float = 0.0
    window_week: float = 0.0

    def as_usage(self) -> Dict[str, Any]:
        return {
            "credits_5h": self.credits_5h,
            "limit_5h": self.limit_5h,
            "reset_5h_seconds": self.reset_5h_seconds,
            "credits_week": self.credits_week,
            "limit_week": self.limit_week,
            "reset_week_seconds": self.reset_week_seconds,
            "scope": self.scope,
        }


def _windows(reservation: Optional[QuotaDecision]) -> Dict[str, float]:
    if reservation is None or not reservation.allowed:
        return {}
    return {"window_5h": reservation.window_5h, "window_week": reservation.window_week}


class QuotaService:
    """Server-side chat credit windows. Crisis turns must not reserve credits."""

    def __init__(
        self,
        store: Any | None = None,
        *,
        limit_5h: int = LIMIT_5H,
        limit_week: int = LIMIT_WEEK,
        anon_limit_5h: int = ANON_LIMIT_5H,
        anon_limit_week: int = ANON_LIMIT_WEEK,
    ) -> None:
        self.store = store or get_store()
        self.limit_5h = limit_5h
        self.limit_week = limit_week
        self.anon_limit_5h = anon_limit_5h
        self.anon_limit_week = anon_limit_week

    def _now(self) -> float:
        return time.time()

    def _limits(self, *, anonymous: bool) -> tuple[int, int]:
        if anonymous:
            # Guests shed first under load so signed-in people keep capacity.
            # Signed-in limits never move with load.
            scale = _anonymous_load_scale()
            return max(1, int(self.anon_limit_5h * scale)), max(1, int(self.anon_limit_week * scale))
        return self.limit_5h, self.limit_week

    def _fresh_doc(self, subject: str, now: float) -> Dict[str, Any]:
        return {
            "subject": subject,
            "total_credits_5h": 0,
            "total_credits_week": 0,
            "five_hour_reset_time": now + WINDOW_5H_SECONDS,
            "week_reset_time": now + WINDOW_WEEK_SECONDS,
        }

    def _load(self, collection: str, subject: str, now: float) -> Dict[str, Any]:
        return self._normalize(self.store.get_document(collection, subject), subject, now)

    def _normalize(self, doc: Optional[Dict[str, Any]], subject: str, now: float) -> Dict[str, Any]:
        """Normalize stored quota data and apply window rollovers."""
        if not doc:
            return self._fresh_doc(subject, now)
        doc = dict(doc)
        if "total_credits_5h" not in doc and "used" in doc:
            used = int(doc.get("used") or 0)
            doc = {
                "subject": subject,
                "total_credits_5h": used,
                "total_credits_week": used,
                "five_hour_reset_time": now + WINDOW_5H_SECONDS,
                "week_reset_time": now + WINDOW_WEEK_SECONDS,
            }
        if now >= float(doc.get("five_hour_reset_time") or 0):
            doc["total_credits_5h"] = 0
            doc["five_hour_reset_time"] = now + WINDOW_5H_SECONDS
        if now >= float(doc.get("week_reset_time") or 0):
            doc["total_credits_week"] = 0
            doc["week_reset_time"] = now + WINDOW_WEEK_SECONDS
        return doc

    def _decision(
        self,
        doc: Dict[str, Any],
        *,
        cost: int,
        allowed: bool,
        now: float,
        limit_5h: int,
        limit_week: int,
        scope: str,
    ) -> QuotaDecision:
        return QuotaDecision(
            allowed=allowed,
            cost=cost,
            credits_5h=int(doc.get("total_credits_5h") or 0),
            limit_5h=limit_5h,
            reset_5h_seconds=max(0, int(float(doc.get("five_hour_reset_time") or now) - now)),
            credits_week=int(doc.get("total_credits_week") or 0),
            limit_week=limit_week,
            reset_week_seconds=max(0, int(float(doc.get("week_reset_time") or now) - now)),
            scope=scope,
            window_5h=float(doc.get("five_hour_reset_time") or 0.0),
            window_week=float(doc.get("week_reset_time") or 0.0),
        )

    def _empty_denied(self, cost: int, *, anonymous: bool) -> QuotaDecision:
        now = self._now()
        limit_5h, limit_week = self._limits(anonymous=anonymous)
        return self._decision(
            self._fresh_doc("denied", now),
            cost=cost,
            allowed=False,
            now=now,
            limit_5h=limit_5h,
            limit_week=limit_week,
            scope="network" if anonymous else "account",
        )

    def _reserve(
        self,
        collection: str,
        subject: str,
        cost: int,
        *,
        anonymous: bool,
        idempotency_key: str = "",
        request_digest: str = "",
    ) -> QuotaDecision:
        """Reserve `cost` credits atomically.

        Read-check-write is not enough here: two concurrent turns both read the
        same `used` value and both write `used + cost`, so a caller at the limit
        can overshoot by however many requests they can land in one round trip.
        The whole check-and-increment runs inside one store transaction instead.

        A store that cannot complete the transaction denies the turn. Failing
        open would mean an outage silently removes every limit — and because the
        old fallback was per-process memory, an attacker could force it.
        """
        now = self._now()
        limit_5h, limit_week = self._limits(anonymous=anonymous)
        scope = "network" if anonymous else "account"
        idempotency_key = str(idempotency_key or "").strip()[:128]
        request_fingerprint = hashlib.sha256(
            json.dumps(
                {"subject": subject, "cost": cost, "scope": scope, "request": request_digest}, sort_keys=True
            ).encode()
        ).hexdigest()

        def _mutate(
            current: Optional[Dict[str, Any]], write: Any
        ) -> tuple[Dict[str, Any], bool]:
            doc = self._normalize(current, subject, now)
            markers = doc.get("idempotency_markers")
            if not isinstance(markers, dict):
                markers = {}
            if idempotency_key:
                previous = markers.get(idempotency_key)
                if isinstance(previous, dict):
                    if previous.get("fingerprint") != request_fingerprint:
                        raise AppError(
                            "conflict",
                            "Idempotency-Key was reused for a different quota request.",
                        )
                    if previous.get("allowed"):
                        # A replay of a charged turn must never be served for free.
                        # The stream cannot be replayed, so the retry is refused;
                        # a failed turn is refunded and its marker removed, which
                        # is what lets a genuine retry through.
                        raise AppError(
                            "conflict",
                            "This message was already sent. Send it again as a new message if you need another reply.",
                        )
                    # A previously denied attempt is re-evaluated: the window may have reset.
            used_5h = int(doc.get("total_credits_5h") or 0)
            used_week = int(doc.get("total_credits_week") or 0)
            if used_5h + cost > limit_5h or used_week + cost > limit_week:
                if idempotency_key:
                    markers[idempotency_key] = {
                        "fingerprint": request_fingerprint,
                        "allowed": False,
                        "created_at": now,
                    }
                    markers = dict(sorted(markers.items(), key=lambda item: float(item[1].get("created_at") or 0))[-64:])
                    doc["idempotency_markers"] = markers
                    write(doc)
                return doc, False
            doc["total_credits_5h"] = used_5h + cost
            doc["total_credits_week"] = used_week + cost
            if idempotency_key:
                markers[idempotency_key] = {
                    "fingerprint": request_fingerprint,
                    "allowed": True,
                    "created_at": now,
                }
                markers = dict(sorted(markers.items(), key=lambda item: float(item[1].get("created_at") or 0))[-64:])
                doc["idempotency_markers"] = markers
            write(doc)
            return doc, True

        try:
            doc, allowed = self.store.transact(collection, subject, _mutate)
        except StoreUnavailable:
            logger.error(
                "quota_reserve_denied_store_unavailable scope=%s cost=%s", scope, cost
            )
            return self._empty_denied(cost, anonymous=anonymous)

        return self._decision(
            doc,
            cost=cost,
            allowed=allowed,
            now=now,
            limit_5h=limit_5h,
            limit_week=limit_week,
            scope=scope,
        )

    def _refund(
        self,
        collection: str,
        subject: str,
        cost: int,
        *,
        idempotency_key: str = "",
        window_5h: float = 0.0,
        window_week: float = 0.0,
    ) -> None:
        """Give credits back atomically, to the windows they were charged in.

        A turn that fails after its 5-hour window rolled over was charged to the
        old window, which no longer exists. Subtracting it from the new window's
        counter erased a later, successful turn's charge. When the charging
        windows are known, each counter is only touched if it is still that
        window. (0.0 means unknown: a caller from before windows were recorded.)

        A failure here over-charges by `cost` rather than under-charging, so it
        is logged and swallowed: it must never turn an already-failed turn into
        a second error for the caller."""
        now = self._now()

        def _mutate(current: Optional[Dict[str, Any]], write: Any) -> None:
            doc = self._normalize(current, subject, now)
            if not window_5h or float(doc.get("five_hour_reset_time") or 0.0) == window_5h:
                doc["total_credits_5h"] = max(0, int(doc.get("total_credits_5h") or 0) - cost)
            if not window_week or float(doc.get("week_reset_time") or 0.0) == window_week:
                doc["total_credits_week"] = max(0, int(doc.get("total_credits_week") or 0) - cost)
            if idempotency_key and isinstance(doc.get("idempotency_markers"), dict):
                doc["idempotency_markers"].pop(idempotency_key, None)
            write(doc)

        try:
            self.store.transact(collection, subject, _mutate)
        except StoreUnavailable:
            logger.error("quota_refund_failed_store_unavailable cost=%s", cost)

    def snapshot(self, user_id_hash: str) -> QuotaDecision:
        if not is_user_quota_subject(user_id_hash):
            return self._empty_denied(0, anonymous=False)
        now = self._now()
        limit_5h, limit_week = self._limits(anonymous=False)
        return self._decision(
            self._load(USER_QUOTA_COLLECTION, user_id_hash, now),
            cost=0,
            allowed=True,
            now=now,
            limit_5h=limit_5h,
            limit_week=limit_week,
            scope="account",
        )

    def snapshot_anonymous(self, peer: str) -> QuotaDecision:
        now = self._now()
        key = anonymous_quota_key(peer)
        limit_5h, limit_week = self._limits(anonymous=True)
        return self._decision(
            self._load(ANON_RATE_COLLECTION, key, now),
            cost=0,
            allowed=True,
            now=now,
            limit_5h=limit_5h,
            limit_week=limit_week,
            scope="network",
        )

    def check_and_consume_quota(self, user_id_hash: str, cost: int = 1) -> bool:
        return self.reserve(user_id_hash, cost).allowed

    def reserve(self, user_id_hash: str, cost: int = 1, *, idempotency_key: str = "", request_digest: str = "") -> QuotaDecision:
        if not is_user_quota_subject(user_id_hash):
            return self._empty_denied(cost, anonymous=False)
        return self._reserve(
            USER_QUOTA_COLLECTION, user_id_hash, cost, anonymous=False,
            idempotency_key=idempotency_key, request_digest=request_digest,
        )

    def refund_quota(
        self, user_id_hash: str, cost: int = 1, *, idempotency_key: str = "", reservation: Optional[QuotaDecision] = None
    ) -> None:
        if not is_user_quota_subject(user_id_hash):
            return
        self._refund(
            USER_QUOTA_COLLECTION, user_id_hash, cost, idempotency_key=idempotency_key, **_windows(reservation)
        )

    def reserve_anonymous(self, peer: str, cost: int = 1, *, idempotency_key: str = "", request_digest: str = "") -> QuotaDecision:
        return self._reserve(
            ANON_RATE_COLLECTION, anonymous_quota_key(peer), cost, anonymous=True,
            idempotency_key=idempotency_key, request_digest=request_digest,
        )

    def refund_anonymous(
        self, peer: str, cost: int = 1, *, idempotency_key: str = "", reservation: Optional[QuotaDecision] = None
    ) -> None:
        self._refund(
            ANON_RATE_COLLECTION, anonymous_quota_key(peer), cost, idempotency_key=idempotency_key, **_windows(reservation)
        )

    def get_idempotency_result(self, idempotency_key: str) -> Optional[Dict[str, Any]]:
        if not idempotency_key:
            return None
        return self.store.get_document("idempotency_records", idempotency_key)

    def set_idempotency_result(self, idempotency_key: str, payload: Dict[str, Any]) -> None:
        if idempotency_key:
            self.store.set_document("idempotency_records", idempotency_key, payload)
