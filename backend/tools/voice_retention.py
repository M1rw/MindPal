from __future__ import annotations

import time
from typing import Any

from backend.domain.voice.privacy import VoicePrivacyService
from backend.infra.store.store import get_store


def run_voice_retention(*, store: Any | None = None) -> dict[str, int]:
    """Run from a deployment scheduler; safe to retry and safe on serverless.

    Also the daily sweep for other expiring personal data (greetings).
    """
    target = store or get_store()
    removed = VoicePrivacyService(target).purge_expired()
    removed["greeting_cache"] = purge_expired_greetings(target)
    removed["account_deletions"] = _purge_expired(target, "account_deletions")
    return removed


def _purge_expired(store: Any, collection: str) -> int:
    now = time.time()
    removed = 0
    for doc_id, record in list(store.iter_documents(collection)):
        expires_at = record.get("expires_at")
        if isinstance(expires_at, (int, float)) and float(expires_at) <= now and store.delete_document(collection, doc_id):
            removed += 1
    return removed


def purge_expired_greetings(store: Any, *, now: float | None = None) -> int:
    current = float(now if now is not None else time.time())
    removed = 0
    for doc_id, record in list(store.iter_documents("greeting_cache")):
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
