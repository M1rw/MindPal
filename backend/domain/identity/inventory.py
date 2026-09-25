"""Every collection that holds per-account data, and what happens to it.

Export and deletion used to be two hand-written lists that drifted from the
code writing data: personalised greetings survived "delete my data" and were
never exported, and raw journal turns waiting for consolidation were counted
in the export but not included (audit MP-15). This is the one list;
`tests/backend/storage/test_data_inventory.py` seeds every entry and checks
that export and deletion do what it says.

owner key: how the document id or a field identifies the account.
  "id"       document id is the user id hash
  "prefix"   document id starts with "<user id hash>:"
  "field"    a `user_id_hash` field (voice collections)
export / delete:
  "yes" | "no:<reason>"
retention: how long it lives if never deleted.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Tuple


@dataclass(frozen=True)
class OwnedCollection:
    name: str
    owner_key: str
    export: str
    delete: str
    retention: str


INVENTORY: Tuple[OwnedCollection, ...] = (
    OwnedCollection("user_profiles", "id", "yes", "yes", "until deleted"),
    OwnedCollection("memory_graphs", "id", "yes", "yes", "until deleted"),
    OwnedCollection("memory_journal", "id", "yes", "yes", "turns until compacted; digests capped"),
    OwnedCollection("memory_jobs", "id", "no:queue marker, no content", "yes", "until processed"),
    OwnedCollection("chat_sessions", "prefix", "yes", "yes", "until deleted"),
    OwnedCollection("session_telemetry", "prefix", "yes", "yes", "until deleted"),
    OwnedCollection("adaptive_profiles", "id", "yes", "yes", "until deleted"),
    OwnedCollection("greeting_cache", "prefix", "yes", "yes", "2 days"),
    OwnedCollection("user_presence", "id", "no:last-visit timestamp only", "yes", "until deleted"),
    OwnedCollection("changelog_dismissals", "id", "no:release versions only", "yes", "until deleted"),
    # Check-in notification devices: a push endpoint, time zone and language.
    OwnedCollection("push_subscriptions", "prefix", "no:device push addresses only", "yes", "until turned off or expired"),
    # Library files (v5.0.5): metadata and digests here; the bytes are in object
    # storage under "<user id hash>/" and are deleted with the account.
    OwnedCollection("library_files", "prefix", "yes", "yes", "until deleted"),
    OwnedCollection("file_digests", "field", "no:cached readings of files, also in library_files", "yes", "7 days"),
    OwnedCollection("voice_sessions", "field", "yes", "yes", "configured voice retention"),
    OwnedCollection("voice_telemetry", "field", "yes", "yes", "configured voice retention"),
    OwnedCollection("voice_support_diagnostics", "field", "yes", "yes", "configured voice retention"),
    OwnedCollection("voice_event_idempotency", "field", "no:request fingerprints only", "yes", "expires with its record"),
    OwnedCollection("voice_active_sessions", "id", "no:pointer to a session", "yes", "cleared at call end"),
    # Deletion fence for work already in flight (identity/fence.py): a time only.
    OwnedCollection("account_deletions", "id", "no:deletion time only", "no:it is the deletion record", "1 day"),
    # Abuse accounting, kept through "delete my data" so it cannot refill limits
    # (audit MP-05). Counts and reset times only; they expire with their window.
    OwnedCollection("user_quotas", "id", "no:usage counters", "no:abuse accounting, self-expiring", "5 hours / 7 days"),
    OwnedCollection("voice_minute_reservations", "id", "no:usage counters", "no:abuse accounting, self-expiring", "1 day"),
)
