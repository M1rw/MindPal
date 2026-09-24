from __future__ import annotations

import time
from typing import Any

from backend.configs.runtime import api_limits_config
from backend.infra.observability.metrics import request_id
from backend.infra.store.store import get_store

DIAGNOSTICS_COLLECTION = "voice_support_diagnostics"
DIAGNOSTICS_RETENTION_S = 30 * 24 * 60 * 60
MAX_EVENTS = 400
MAX_DEPTH = 6
MAX_STRING_CHARS = 200
MAX_KEYS = 40

_SENSITIVE_TRACE_KEYS = frozenset({
    "text", "transcript", "inputTranscript", "outputTranscript", "input_text", "output_text",
    "message", "reason", "detail", "notes",
})


def _redact(value: Any, depth: int = 0) -> Any:
    """Drop transcript-bearing keys and bound the shape of client-supplied data."""
    if depth >= MAX_DEPTH:
        return None
    if isinstance(value, list):
        return [_redact(item, depth + 1) for item in value[:MAX_EVENTS]]
    if isinstance(value, dict):
        return {
            str(key)[:64]: _redact(item, depth + 1)
            for key, item in list(value.items())[:MAX_KEYS]
            if key not in _SENSITIVE_TRACE_KEYS
        }
    if isinstance(value, str):
        return value[:MAX_STRING_CHARS]
    if isinstance(value, (bool, int, float)) or value is None:
        return value
    return None


def _non_negative_int(value: Any) -> int:
    try:
        return max(0, int(float(value)))
    except (TypeError, ValueError):
        return 0


_VOICE_LIMITS = api_limits_config()["voice"]
MAX_TRACES_PER_SESSION = int(_VOICE_LIMITS["max_traces_per_session"])
MAX_TRACE_EVENTS = int(_VOICE_LIMITS["max_trace_events"])


def persist_voice_diagnostics(session_id: str, trace: dict[str, Any], *, user_id_hash: str = "") -> dict[str, Any]:
    """Store a redacted trace. At most a few per call (audit MP-17: every upload
    was a new document, so a looping client could fill storage)."""
    now = time.time()
    store = get_store()
    existing = sum(1 for _ in store.iter_documents(DIAGNOSTICS_COLLECTION, prefix=f"{session_id}:"))
    if existing >= MAX_TRACES_PER_SESSION:
        return {"ok": True, "session_id": session_id, "request_id": request_id(), "skipped": "limit"}
    events = trace.get("events")
    events = events[-MAX_TRACE_EVENTS:] if isinstance(events, list) else events
    safe_trace = {
        "schema": str(trace.get("schema") or "")[:32],
        "session_id": session_id,
        "user_id_hash": user_id_hash,
        "captured_at": str(trace.get("capturedAt") or "")[:64],
        "duration_ms": _non_negative_int(trace.get("durationMs")),
        "event_count": _non_negative_int(trace.get("eventCount")),
        "dropped_events": _non_negative_int(trace.get("droppedEvents")),
        "findings": _redact(trace.get("findings")) if isinstance(trace.get("findings"), dict) else {},
        "events": _redact(events) if isinstance(events, list) else [],
        "request_id": request_id(),
        "received_at": now,
        "expires_at": now + DIAGNOSTICS_RETENTION_S,
    }
    store.set_document(DIAGNOSTICS_COLLECTION, f"{session_id}:{int(now * 1000)}", safe_trace)
    return {"ok": True, "session_id": session_id, "request_id": request_id()}


def load_voice_diagnostics(session_id: str) -> dict[str, Any]:
    records = [
        record
        for record in get_store().list_documents(DIAGNOSTICS_COLLECTION, prefix=f"{session_id}:")
        if record.get("session_id") == session_id
    ]
    return {"session_id": session_id, "records": records, "request_id": request_id()}
