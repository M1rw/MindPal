"""Writing a live-voice session record without undoing what happened meanwhile.

Every event handler reads the session, works on it (sometimes across a model
call), and writes it back. A plain write replaced whatever was stored by then,
so a slow floor event could turn a settled call back into a live one, or lift a
crisis freeze that another request had just recorded.

`save_session_record` writes through the store's transaction and refuses to
move a session backwards:

* ``torn_down`` is final: only a write that is itself ``torn_down`` (the recap
  adding its summary) may touch it;
* a crisis freeze is only lifted by teardown;
* ``settlement`` belongs to teardown alone and is never overwritten by a stale
  copy;
* a record that no longer exists is not recreated. Only mint creates sessions;
  anything else finding the row gone means the account's data was deleted
  while it was working (a recap paused on its model call used to bring the
  deleted session back).
"""

from __future__ import annotations

from typing import Any, Dict, Optional

VOICE_SESSION_COLLECTION = "voice_sessions"


def is_frozen(record: Dict[str, Any]) -> bool:
    return record.get("status") == "crisis_freeze" or record.get("floor") == "crisis_freeze"


def save_session_record(store: Any, session_id: str, record: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Returns what is stored afterwards: the new record, or the one that won."""

    def mutate(current: Optional[Dict[str, Any]], write: Any) -> Optional[Dict[str, Any]]:
        if not current:
            return None
        incoming_final = record.get("status") == "torn_down"
        if current.get("status") == "torn_down" and not incoming_final:
            return current
        if is_frozen(current) and not is_frozen(record) and not incoming_final:
            return current
        merged = dict(record)
        if "settlement" in current:
            merged["settlement"] = current["settlement"]
        write(merged)
        return merged

    return store.transact(VOICE_SESSION_COLLECTION, session_id, mutate)
