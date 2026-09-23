from __future__ import annotations

import time
from typing import Any

from backend.configs.runtime import voice_runtime_settings

RAW_RETENTION_S = voice_runtime_settings().session.retention_seconds
SAFETY_RETENTION_S = 90 * 24 * 60 * 60
SUMMARY_RETENTION_S = 365 * 24 * 60 * 60
IDEMPOTENCY_RETENTION_S = 24 * 60 * 60


class VoicePrivacyService:
    """Owns retention, export, and deletion of voice-owned data."""

    def __init__(self, store: Any) -> None:
        self.store = store

    def purge_expired(self, *, now: float | None = None) -> dict[str, int]:
        current = float(now if now is not None else time.time())
        removed = {
            "voice_support_diagnostics": self._purge_collection("voice_support_diagnostics", current),
            "voice_sessions": self._purge_collection("voice_sessions", current),
            "voice_telemetry": self._purge_collection("voice_telemetry", current),
            "voice_event_idempotency": self._purge_idempotency(current),
            "voice_active_sessions": self._purge_orphan_active_sessions(),
        }
        return removed

    def export_account(self, user_id_hash: str) -> dict[str, Any]:
        sessions = [self._session_export(record) for _doc_id, record in self._owned("voice_sessions", user_id_hash)]
        telemetry = [self._telemetry_export(record) for _doc_id, record in self._owned("voice_telemetry", user_id_hash)]
        return {
            "policy": {
                "raw_transcripts": "not_exported",
                "safety_events": "sanitized_90_day_retention",
                "summaries": "exported_through_chat_history",
                "audio": "not_recorded",
            },
            "sessions": sessions,
            "safety_events": telemetry,
        }

    def delete_account(self, user_id_hash: str) -> dict[str, int]:
        deleted = {collection: 0 for collection in (
            "voice_sessions", "voice_telemetry", "voice_event_idempotency",
            "voice_active_sessions", "voice_minute_reservations", "voice_support_diagnostics",
        )}
        for collection in ("voice_sessions", "voice_telemetry", "voice_event_idempotency", "voice_support_diagnostics"):
            for document_id, _record in self._owned(collection, user_id_hash):
                if self.store.delete_document(collection, document_id):
                    deleted[collection] += 1
        for collection in ("voice_active_sessions", "voice_minute_reservations"):
            if user_id_hash and self.store.get_document(collection, user_id_hash) is not None:
                if self.store.delete_document(collection, user_id_hash):
                    deleted[collection] += 1
        return deleted

    def _owned(self, collection: str, user_id_hash: str) -> list[tuple[str, dict[str, Any]]]:
        """Documents owned by one account, found by field query with their real ids.

        Never reconstructs ids from document fields and never scans other
        accounts' rows (the old full scan also stopped at PostgREST's row cap,
        leaving data behind on account deletion).
        """
        if not user_id_hash:
            return []
        return [(doc_id, record) for doc_id, record in self.store.query_documents(collection, "user_id_hash", user_id_hash) if doc_id]

    def _purge_collection(self, collection: str, now: float) -> int:
        removed = 0
        for document_id, record in list(self.store.iter_documents(collection)):
            expires_at = record.get("expires_at")
            if isinstance(expires_at, (int, float)) and float(expires_at) <= now:
                if self.store.delete_document(collection, document_id):
                    removed += 1
        return removed

    def _purge_idempotency(self, now: float) -> int:
        removed = 0
        for document_id, record in list(self.store.iter_documents("voice_event_idempotency")):
            expiry = float(record.get("expires_at") or record.get("completed_at") or record.get("created_at") or now + 1)
            if expiry <= now and self.store.delete_document("voice_event_idempotency", document_id):
                removed += 1
        return removed

    def _purge_orphan_active_sessions(self) -> int:
        removed = 0
        for document_id, active in list(self.store.iter_documents("voice_active_sessions")):
            session_id = str(active.get("session_id") or "")
            session = self.store.get_document("voice_sessions", session_id) if session_id else None
            if not session or session.get("status") == "torn_down":
                if self.store.delete_document("voice_active_sessions", document_id):
                    removed += 1
        return removed

    @staticmethod
    def _session_export(record: dict[str, Any]) -> dict[str, Any]:
        return {
            "session_id": record.get("session_id"),
            "created_at": record.get("created_at"),
            "ended_at": record.get("ended_at"),
            "status": record.get("status"),
            "session_mode": record.get("session_mode"),
            "used_s": record.get("used_s", 0),
            "summary": record.get("summary_text"),
        }

    @staticmethod
    def _telemetry_export(record: dict[str, Any]) -> dict[str, Any]:
        return {
            "event": record.get("event"),
            "source": record.get("source"),
            "outcome": record.get("outcome"),
            "duration_ms": record.get("duration_ms", 0),
            "reason": record.get("reason"),
            "metadata": record.get("metadata", {}),
            "ts": record.get("ts"),
        }
