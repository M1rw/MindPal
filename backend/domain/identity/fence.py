"""A fence between "delete my data" and work that was already running.

Deletion is a sweep over collections, but a chat turn, a memory consolidation
or a call recap can be halfway through at that moment (usually waiting on a
model) and write its results afterwards, bringing deleted data back after the
person was told it was gone (audit MP-06).

`mark_deleted` records when the account's data was deleted, before the sweep
starts. Work records when it started and checks `deleted_since(started_at)`
before persisting anything; if the data was deleted after it began, its
results belong to data that no longer exists and are dropped. Work that starts
after the deletion is new activity and writes normally.

The tombstone holds only the user id hash and a time, and expires after a day:
nothing in flight lives that long.
"""

from __future__ import annotations

import time
from typing import Any, Optional

DELETIONS_COLLECTION = "account_deletions"
TOMBSTONE_RETENTION_S = 24 * 3600


def mark_deleted(store: Any, user_id_hash: str, *, now: Optional[float] = None) -> float:
    at = float(now if now is not None else time.time())
    store.set_document(
        DELETIONS_COLLECTION,
        user_id_hash,
        {"user_id_hash": user_id_hash, "deleted_at": at, "expires_at": at + TOMBSTONE_RETENTION_S},
    )
    return at


def deleted_since(store: Any, user_id_hash: str, started_at: float) -> bool:
    """True if this account's data was deleted after `started_at`."""
    if not user_id_hash:
        return False
    try:
        record = store.get_document(DELETIONS_COLLECTION, user_id_hash)
    except Exception:
        # Cannot tell: refuse the write rather than risk bringing data back.
        return True
    deleted_at = (record or {}).get("deleted_at")
    return isinstance(deleted_at, (int, float)) and float(deleted_at) >= started_at
