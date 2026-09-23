from __future__ import annotations

import logging
import time
from typing import Any

from backend.configs.runtime import voice_runtime_settings
from backend.infra.store.providers.memory import InMemoryStore
from backend.infra.store.shared import StoreUnavailable

logger = logging.getLogger("mindpal.voice.telemetry")

VOICE_TELEMETRY_RETENTION_S = voice_runtime_settings().session.retention_seconds
_SAFE_METADATA_KEYS = frozenset(
    {
        "band", "danger_kind", "risk", "from", "to", "remaining_s", "reserved_s",
        "used_s", "refund_s", "setup_failed", "t_setup_ms", "elapsed_s", "auth",
        "session_mode", "provider", "operation",
    }
)


def _safe_metadata(metadata: dict[str, Any] | None) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in (metadata or {}).items():
        if key not in _SAFE_METADATA_KEYS:
            continue
        if isinstance(value, (bool, int, float)):
            result[key] = value
        elif isinstance(value, str):
            result[key] = value[:80]
    return result


class VoiceTelemetryService:
    """Focused telemetry sink for live voice product events.

    This is deliberately small and structured so the feature can evolve into a
    richer analytics pipeline without coupling the voice runtime to product
    instrumentation details.
    """

    def __init__(self, store: Any | None = None) -> None:
        self.store = store or InMemoryStore()

    def record_event(
        self,
        *,
        user_id_hash: str,
        session_id: str,
        event_name: str,
        source: str = "client",
        reason: str | None = None,
        outcome: str = "ok",
        duration_ms: int | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        now = time.time()
        event = {
            "user_id_hash": user_id_hash,
            "session_id": session_id,
            "event": event_name,
            "source": source,
            "reason": reason or "",
            "outcome": outcome,
            "duration_ms": int(duration_ms or 0),
            "metadata": _safe_metadata(metadata),
            "ts": now,
            "expires_at": now + VOICE_TELEMETRY_RETENTION_S,
        }
        try:
            self.store.set_document(
                "voice_telemetry", f"{user_id_hash}:{session_id}:{event_name}:{int(event['ts'] * 1000)}", event
            )
        except StoreUnavailable:
            # Telemetry is observability. A storage blip must never fail the
            # mint, event, or teardown that produced it.
            logger.warning("voice_telemetry_write_skipped event=%s", event_name)
        return event

    def purge_expired(self, *, now: float | None = None) -> int:
        cutoff = float(now if now is not None else time.time())
        removed = 0
        for document_id, document in list(self.store.iter_documents("voice_telemetry")):
            expires_at = document.get("expires_at")
            if isinstance(expires_at, (int, float)) and expires_at <= cutoff:
                if self.store.delete_document("voice_telemetry", document_id):
                    removed += 1
        return removed

    def events_for_session(self, user_id_hash: str, session_id: str) -> list[dict[str, Any]]:
        now = time.time()
        return [
            event
            for event in self.store.list_documents("voice_telemetry", prefix=f"{user_id_hash}:{session_id}:")
            if event.get("user_id_hash") == user_id_hash
            and event.get("session_id") == session_id
            and float(event.get("expires_at") or now + 1) > now
        ]
