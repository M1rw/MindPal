from __future__ import annotations

import time
from dataclasses import dataclass, field
from threading import Lock
from typing import TypedDict


class ChatTurn(TypedDict):
    role: str
    text: str


@dataclass
class SessionState:
    history: list[ChatTurn] = field(default_factory=list)
    updated_at: float = field(default_factory=time.time)


class SessionMemoryStore:
    def __init__(self, ttl_seconds: int = 60 * 60 * 24, max_turns: int = 64) -> None:
        self._ttl_seconds = ttl_seconds
        self._max_turns = max_turns
        self._sessions: dict[str, SessionState] = {}
        self._lock = Lock()

    def _cleanup_expired_locked(self, now: float) -> None:
        expired_ids = [
            session_id
            for session_id, state in self._sessions.items()
            if now - state.updated_at > self._ttl_seconds
        ]
        for session_id in expired_ids:
            self._sessions.pop(session_id, None)

    def _sanitize_history(self, history: list[dict[str, str]] | list[ChatTurn]) -> list[ChatTurn]:
        cleaned: list[ChatTurn] = []
        for item in history:
            role = str(item.get("role", "")).strip().lower()
            text = str(item.get("text", "")).strip()
            if role not in {"user", "assistant"}:
                continue
            if not text:
                continue
            cleaned.append({"role": role, "text": text[:4000]})

        if len(cleaned) > self._max_turns:
            cleaned = cleaned[-self._max_turns :]

        return cleaned

    def get_history(self, session_id: str) -> list[ChatTurn]:
        now = time.time()
        with self._lock:
            self._cleanup_expired_locked(now)
            state = self._sessions.get(session_id)
            if not state:
                return []
            state.updated_at = now
            return list(state.history)

    def replace_history(self, session_id: str, history: list[dict[str, str]] | list[ChatTurn]) -> None:
        now = time.time()
        cleaned = self._sanitize_history(history)
        with self._lock:
            self._cleanup_expired_locked(now)
            self._sessions[session_id] = SessionState(history=cleaned, updated_at=now)

    def append_turn(self, session_id: str, role: str, text: str) -> None:
        role_clean = role.strip().lower()
        text_clean = text.strip()
        if role_clean not in {"user", "assistant"} or not text_clean:
            return

        now = time.time()
        with self._lock:
            self._cleanup_expired_locked(now)
            state = self._sessions.get(session_id)
            if not state:
                state = SessionState()
                self._sessions[session_id] = state

            state.history.append({"role": role_clean, "text": text_clean[:4000]})
            if len(state.history) > self._max_turns:
                state.history = state.history[-self._max_turns :]
            state.updated_at = now

    def clear(self, session_id: str) -> bool:
        with self._lock:
            return self._sessions.pop(session_id, None) is not None

    def export(self, session_id: str) -> dict[str, object]:
        now = time.time()
        with self._lock:
            self._cleanup_expired_locked(now)
            state = self._sessions.get(session_id)
            if not state:
                return {
                    "session_id": session_id,
                    "found": False,
                    "history": [],
                }

            return {
                "session_id": session_id,
                "found": True,
                "history": list(state.history),
                "updated_at_unix": state.updated_at,
            }
