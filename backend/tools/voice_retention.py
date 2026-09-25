from __future__ import annotations

import time
from typing import Any

from backend.domain.voice.privacy import VoicePrivacyService
from backend.infra.store.store import get_store


# Per sweep; all sweeps together stay inside the function's 60s limit.
SWEEP_TIME_BUDGET_S = 5.0


def run_voice_retention(*, store: Any | None = None) -> dict[str, int]:
    """Run from a deployment scheduler; safe to retry and safe on serverless.

    Also the daily sweep for other expiring personal data (greetings, cached
    file readings, daily file allowances).
    """
    target = store or get_store()
    removed = VoicePrivacyService(target).purge_expired()
    removed["greeting_cache"] = purge_expired_greetings(target)
    removed["account_deletions"] = _purge_expired(target, "account_deletions")
    # Files (v5.0.5): cached page readings (7 days) and daily file allowances.
    removed["file_digests"] = _purge_expired(target, "file_digests")
    removed["file_allowance"] = _purge_expired(target, "file_allowance")
    return removed


def _purge_expired(store: Any, collection: str) -> int:
    now = time.time()
    removed = 0
    deadline = time.monotonic() + SWEEP_TIME_BUDGET_S
    for doc_id, record in list(store.iter_documents(collection)):
        if time.monotonic() >= deadline:
            break
        expires_at = record.get("expires_at")
        if isinstance(expires_at, (int, float)) and float(expires_at) <= now and store.delete_document(collection, doc_id):
            removed += 1
    return removed


def purge_expired_greetings(store: Any, *, now: float | None = None) -> int:
    current = float(now if now is not None else time.time())
    removed = 0
    deadline = time.monotonic() + SWEEP_TIME_BUDGET_S
    for doc_id, record in list(store.iter_documents("greeting_cache")):
        if time.monotonic() >= deadline:
            break  # the rest goes on the next daily run
        # Rows from before expiry was recorded count as expired: they are at
        # least a day old by the time this runs.
        expires_at = record.get("expires_at")
        if (not isinstance(expires_at, (int, float)) or float(expires_at) <= current) and store.delete_document(
            "greeting_cache", doc_id
        ):
            removed += 1
    return removed


if __name__ == "__main__":
    print(run_voice_retention())
