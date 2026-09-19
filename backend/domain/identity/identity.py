# backend/domain/identity/identity.py — User Identity and Profile Domain

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional, Set

from fastapi import Header

from backend.core.errors import AppError
from backend.domain.memory.graph import MemoryGraphService
from backend.infra.auth.verifier import AuthVerifier, UserSession
from backend.infra.store.store import get_store

_EXPORT_INCLUDED = ["profile", "memory", "cloud_chat_sessions"]
_EXPORT_NOT_INCLUDED = [
    "Chat history stored only in this browser",
    "Guest memory facts stored only on this device",
    "Sign-in tokens",
]
_ACCOUNT_SIDE_COLLECTIONS = (
    "user_presence",
    "changelog_dismissals",
    "voice_minute_reservations",
    "voice_active_sessions",
)


class IdentityService:
    """Manages User Profiles, Export, and Account Deletion."""

    def __init__(self) -> None:
        self.store = get_store()

    def get_profile(self, user_id_hash: str) -> Dict[str, Any]:
        """The stored profile, or the defaults it would start from.

        A read does not create the record. Writing one on every GET meant an
        account that only ever looked at its settings still accumulated a row,
        and a storage outage turned a read into a failed write.
        """
        profile = self.store.get_document("user_profiles", user_id_hash)
        if profile:
            return profile
        return {
            "user_id_hash": user_id_hash,
            "display_name": "MindPal User",
            "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "settings": {"language": "en", "theme": "system"},
        }

    def export_data(self, user_id_hash: str) -> Dict[str, Any]:
        """Return stored account data only. Does not create a profile as a side effect."""
        profile = self.store.get_document("user_profiles", user_id_hash) or {}
        graph = MemoryGraphService(self.store).get_memory_graph(user_id_hash)
        return {
            "exported_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "included": list(_EXPORT_INCLUDED),
            "not_included": list(_EXPORT_NOT_INCLUDED),
            "profile": dict(profile),
            "memory": {
                "summary": graph.summary,
                "atoms": [
                    {
                        "id": atom.id,
                        "category": atom.category,
                        "value": atom.value,
                        "confidence": atom.confidence,
                    }
                    for atom in graph.atoms
                ],
            },
            "cloud_chat_sessions": _cloud_chat_sessions(self.store, user_id_hash),
        }

    def delete_account(self, user_id_hash: str) -> Dict[str, Any]:
        """Permanently delete server profile, memory graph, and synced chats for this account."""
        deleted: List[str] = []
        if self.store.delete_document("user_profiles", user_id_hash):
            deleted.append("profile")
        if self.store.delete_document("memory_graphs", user_id_hash):
            deleted.append("memory")

        sessions_removed = False
        if self.store.delete_document("chat_sessions", user_id_hash):
            sessions_removed = True
        for doc in self.store.list_documents("chat_sessions", prefix=f"{user_id_hash}:"):
            session_id = doc.get("id")
            if isinstance(session_id, str) and session_id:
                if self.store.delete_document("chat_sessions", f"{user_id_hash}:{session_id}"):
                    sessions_removed = True
        if sessions_removed:
            deleted.append("cloud_chat_sessions")

        for collection in _ACCOUNT_SIDE_COLLECTIONS:
            self.store.delete_document(collection, user_id_hash)

        for doc in self.store.list_documents("session_telemetry", prefix=f"{user_id_hash}:"):
            session_id = doc.get("session_id")
            if isinstance(session_id, str) and session_id:
                self.store.delete_document("session_telemetry", f"{user_id_hash}:{session_id}")

        return {"deleted": deleted}

    def get_insights(self, user_id_hash: str) -> Dict[str, Any]:
        """Counts stored user turns only. Does not invent PHQ-9 / GAD-7 scores."""
        sessions = _cloud_chat_sessions(self.store, user_id_hash)

        seen_ids: set[int] = set()
        user_turns = 0
        days: Set[str] = set()
        for sess in sessions:
            marker = id(sess)
            if marker in seen_ids:
                continue
            seen_ids.add(marker)
            for msg in sess.get("messages") or []:
                if str(msg.get("role") or "").lower() != "user":
                    continue
                user_turns += 1
                timestamp = msg.get("timestamp") or msg.get("created_at") or msg.get("createdAt")
                if isinstance(timestamp, str) and len(timestamp) >= 10:
                    days.add(timestamp[:10])

        parsed = _parse_day_set(days)
        return {
            "user_id_hash": user_id_hash,
            "reflection_streak_days": _consecutive_utc_days(parsed),
            "total_reflections": user_turns,
            "week_active": _week_active_mon_sun(parsed),
            "last_active_date": max(parsed).isoformat() if parsed else None,
        }

    def get_wellness_timeline(self, user_id_hash: str) -> Dict[str, Any]:
        """Coarse mood/event reflection from stored memory and synced user turns."""
        from backend.domain.wellness.timeline import (
            SOURCE_ACCOUNT,
            SOURCE_ACCOUNT_LABEL,
            build_wellness_timeline,
        )

        graph = MemoryGraphService(self.store).get_memory_graph(user_id_hash)
        turns = _user_turns(_cloud_chat_sessions(self.store, user_id_hash))
        return build_wellness_timeline(
            atoms=graph.atoms,
            turns=turns,
            source=SOURCE_ACCOUNT,
            source_label=SOURCE_ACCOUNT_LABEL,
        )


def verify_auth_header(auth_header: Optional[str]) -> UserSession:
    """Resolve the caller. Raises ``unauthenticated`` for a credential that does
    not verify; returns a keyless guest only when no credential was sent."""
    return AuthVerifier().verify_authorization_header(auth_header)


def require_account(auth_header: Optional[str], *, action: str) -> UserSession:
    """Gate for every route that reads or writes durable per-user state.

    Guests have no server-side storage key, so there is nothing for these routes
    to address. Returning someone else's bucket — which a shared guest id did —
    is not a degraded mode, it is a data leak. `action` completes the sentence
    "Sign in to ...".
    """
    session = verify_auth_header(auth_header)
    if not session.has_account_storage:
        raise AppError("unauthenticated", f"Sign in to {action}.")
    return session


def account_guard(action: str) -> Callable[[Optional[str]], UserSession]:
    """`require_account` as a FastAPI dependency.

    Declared as a dependency rather than called in the body so the credential is
    checked before the request body is validated. Called in the body, an
    unauthenticated POST with a malformed payload answered 422 and described the
    schema it wanted; now it answers 401 and describes nothing.
    """

    def _dependency(authorization: Optional[str] = Header(None)) -> UserSession:
        return require_account(authorization, action=action)

    return _dependency


def optional_account(authorization: Optional[str] = Header(None)) -> UserSession:
    """Dependency for routes that answer guests as well as accounts."""
    return verify_auth_header(authorization)


def _cloud_chat_sessions(store: Any, user_id_hash: str) -> List[Dict[str, Any]]:
    sessions: List[Dict[str, Any]] = []
    current = store.get_document("chat_sessions", user_id_hash)
    if current:
        sessions.append(dict(current))
    sessions.extend(dict(doc) for doc in store.list_documents("chat_sessions", prefix=f"{user_id_hash}:"))
    return sessions


def _user_turns(sessions: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    turns: List[Dict[str, str]] = []
    seen_ids: set[int] = set()
    for sess in sessions:
        marker = id(sess)
        if marker in seen_ids:
            continue
        seen_ids.add(marker)
        fallback = sess.get("updatedAt") or sess.get("createdAt") or sess.get("updated_at") or ""
        for msg in sess.get("messages") or []:
            if str(msg.get("role") or "").lower() != "user":
                continue
            content = str(msg.get("content") or msg.get("text") or "").strip()
            if not content:
                continue
            timestamp = msg.get("timestamp") or msg.get("created_at") or msg.get("createdAt") or fallback
            turns.append(
                {
                    "content": content,
                    "timestamp": timestamp if isinstance(timestamp, str) else "",
                }
            )
    return turns


def _parse_day_set(days: Set[str]) -> set[date]:
    parsed: set[date] = set()
    for raw in days:
        try:
            parsed.add(date.fromisoformat(raw[:10]))
        except ValueError:
            continue
    return parsed


def _consecutive_utc_days(parsed: set[date]) -> int:
    if not parsed:
        return 0
    today = date.today()
    start = today if today in parsed else today - timedelta(days=1)
    if start not in parsed:
        return 0
    streak = 0
    cursor = start
    while cursor in parsed:
        streak += 1
        cursor -= timedelta(days=1)
    return streak


def _week_active_mon_sun(parsed: set[date]) -> list[bool]:
    today = date.today()
    monday = today - timedelta(days=today.weekday())
    return [(monday + timedelta(days=offset)) in parsed for offset in range(7)]
