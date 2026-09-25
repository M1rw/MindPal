"""Opt-in check-in notifications.

A person who turns them on gets, at most once a day and only in their local
daytime, a gentle nudge when one of their follow-ups has come due ("How did
the Friday exam go?" the day after). Nothing else triggers one: no streaks,
no "we miss you". The push itself is empty (infra/push/webpush.py): the words
stay in the app, where the greeting asks the question when they open it.

Subscriptions live in `push_subscriptions`, one document per device, keyed
"<user id hash>:<endpoint hash>". A dead subscription (404/410) is dropped.
"""

from __future__ import annotations

import hashlib
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional

from backend.configs.settings import get_settings
from backend.core.errors import AppError
from backend.domain.followups import due_threads, local_today
from backend.domain.memory.extract import can_persist_user_memory
from backend.domain.memory.graph import MemoryGraphService
from backend.infra.push.webpush import PushFailed, PushGone, allowed_endpoint, public_key_for, send_empty_push
from backend.infra.store.store import get_store

logger = logging.getLogger("mindpal.notifications")

COLLECTION = "push_subscriptions"
MAX_DEVICES = 5
# Local hours a nudge may arrive: never early morning or late at night.
DAY_START_HOUR = 9
DAY_END_HOUR = 21
MIN_GAP_S = 20 * 3600
MAX_USERS_PER_RUN = 400


def _endpoint_key(endpoint: str) -> str:
    return hashlib.sha256(endpoint.encode("utf-8")).hexdigest()[:24]


class NotificationService:
    def __init__(
        self,
        store: Any = None,
        memory: Optional[MemoryGraphService] = None,
        send: Callable[[str, str, str], None] = send_empty_push,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._store = store
        self._memory = memory
        self._send = send
        self._clock = clock

    @property
    def store(self) -> Any:
        return self._store if self._store is not None else get_store()

    @property
    def memory(self) -> MemoryGraphService:
        return self._memory or MemoryGraphService(self.store)

    @staticmethod
    def _private_key() -> str:
        return get_settings().vapid_private_key.get_secret_value().strip()

    def available(self) -> bool:
        return bool(self._private_key())

    def public_key(self) -> str:
        key = self._private_key()
        return public_key_for(key) if key else ""

    def _devices(self, user: str) -> List[tuple[str, Dict[str, Any]]]:
        return list(self.store.iter_documents(COLLECTION, prefix=f"{user}:"))

    def status(self, user: str) -> Dict[str, Any]:
        return {"available": self.available(), "public_key": self.public_key(), "devices": len(self._devices(user))}

    def subscribe(self, user: str, endpoint: str, *, tz_offset: int, lang: str) -> Dict[str, Any]:
        if not self.available():
            raise AppError("unavailable", "Notifications aren't available right now.")
        if not can_persist_user_memory(user):
            raise AppError("forbidden", "Notifications need a signed-in account.")
        if not allowed_endpoint(endpoint):
            raise AppError("payload_invalid", "That isn't a push subscription this browser can use.")
        devices = sorted(self._devices(user), key=lambda item: float(item[1].get("created_at") or 0))
        key = f"{user}:{_endpoint_key(endpoint)}"
        if key not in {doc_id for doc_id, _ in devices} and len(devices) >= MAX_DEVICES:
            self.store.delete_document(COLLECTION, devices[0][0])  # the oldest device makes room
        existing = self.store.get_document(COLLECTION, key) or {}
        self.store.set_document(
            COLLECTION,
            key,
            {
                **existing,
                "user_id_hash": user,
                "endpoint": endpoint,
                "tz_offset": max(-840, min(840, int(tz_offset))),
                "lang": "ar" if str(lang).lower().startswith("ar") else "en",
                "created_at": existing.get("created_at") or self._clock(),
            },
        )
        return self.status(user)

    def unsubscribe(self, user: str, endpoint: str) -> Dict[str, Any]:
        self.store.delete_document(COLLECTION, f"{user}:{_endpoint_key(endpoint)}")
        return self.status(user)

    # ---------------------------------------------------------------- daily run

    def run_daily(self) -> Dict[str, int]:
        """Send due check-ins. Called once a day by the scheduler."""
        private_key = self._private_key()
        report = {"users": 0, "sent": 0, "gone": 0, "failed": 0, "skipped": 0}
        if not private_key:
            return report
        subject = get_settings().vapid_subject
        by_user: Dict[str, List[tuple[str, Dict[str, Any]]]] = {}
        for doc_id, doc in self.store.iter_documents(COLLECTION):
            user = str(doc.get("user_id_hash") or doc_id.split(":", 1)[0])
            by_user.setdefault(user, []).append((doc_id, doc))
        now = self._clock()
        jobs: List[tuple[str, str, Dict[str, Any], str]] = []
        for user, devices in list(by_user.items())[:MAX_USERS_PER_RUN]:
            report["users"] += 1
            question = self._due_question(user, devices, now)
            if not question:
                report["skipped"] += 1
                continue
            jobs.extend((user, doc_id, doc, question) for doc_id, doc in devices)

        def deliver(job: tuple[str, str, Dict[str, Any], str]) -> str:
            _user, doc_id, doc, question = job
            try:
                self._send(str(doc.get("endpoint") or ""), private_key, subject)
            except PushGone:
                self.store.delete_document(COLLECTION, doc_id)
                return "gone"
            except PushFailed as exc:
                logger.warning("push_failed detail=%s", str(exc)[:120])
                return "failed"
            self.store.set_document(COLLECTION, doc_id, {**doc, "last_sent_at": now, "last_question": question})
            return "sent"

        with ThreadPoolExecutor(max_workers=12) as pool:
            for outcome in pool.map(deliver, jobs):
                report[outcome] += 1
        logger.info("push_daily users=%s sent=%s gone=%s failed=%s", report["users"], report["sent"], report["gone"], report["failed"])
        return report

    def _due_question(self, user: str, devices: List[tuple[str, Dict[str, Any]]], now: float) -> str:
        if not can_persist_user_memory(user):
            return ""
        latest = max(devices, key=lambda item: float(item[1].get("created_at") or 0))[1]
        offset = int(latest.get("tz_offset") or 0)
        local = datetime.fromtimestamp(now, timezone.utc) + timedelta(minutes=offset)
        if not DAY_START_HOUR <= local.hour < DAY_END_HOUR:
            return ""
        if any(now - float(doc.get("last_sent_at") or 0) < MIN_GAP_S for _, doc in devices):
            return ""
        asked = {str(doc.get("last_question") or "") for _, doc in devices}
        graph = self.memory.get_memory_graph(user)
        for question in due_threads(graph, local_today(offset, datetime.fromtimestamp(now, timezone.utc))):
            if question not in asked:
                return question
        return ""
