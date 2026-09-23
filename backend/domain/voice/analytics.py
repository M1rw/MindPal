from __future__ import annotations

from collections import Counter
from typing import Any

from backend.domain.voice.telemetry import VoiceTelemetryService
from backend.infra.store.providers.memory import InMemoryStore


def _coalesce_text(value: Any) -> str:
    return str(value or "").strip()


_RISK_BAND_PRIORITY = {
    "support": 1,
    "imminent": 2,
}


def _highest_risk_band(bands: list[str], fallback: str | None = None) -> str | None:
    values = [band for band in bands if band]
    if fallback:
        values.append(fallback)
    return max(values, key=lambda band: _RISK_BAND_PRIORITY.get(band, 0), default=None)


class VoiceAnalyticsService:
    """Aggregates the live voice telemetry stream into reviewable summaries.

    This keeps analytics separate from the runtime and lets product/operations
    inspect session health without reading raw data or coupling the live feature
    to dashboard code.
    """

    def __init__(self, store: Any | None = None) -> None:
        self.store = store or InMemoryStore()
        self.telemetry = VoiceTelemetryService(store=self.store)

    def summarize_session(self, user_id_hash: str, session_id: str) -> dict[str, Any]:
        # Retention runs on the scheduler, not inside a user's request.
        events = self.telemetry.events_for_session(user_id_hash, session_id)

        if not events:
            return {
                "user_id_hash": user_id_hash,
                "session_id": session_id,
                "event_count": 0,
                "events_by_name": {},
                "outcomes": {},
                "duration_ms_total": 0,
                "status": "no_events",
            }

        by_name = Counter(str(event.get("event") or "unknown") for event in events)
        outcomes = Counter(str(event.get("outcome") or "unknown") for event in events)
        duration_total = sum(int(event.get("duration_ms") or 0) for event in events)

        return {
            "user_id_hash": user_id_hash,
            "session_id": session_id,
            "event_count": len(events),
            "events_by_name": dict(sorted(by_name.items())),
            "outcomes": dict(sorted(outcomes.items())),
            "duration_ms_total": duration_total,
            "status": "ok",
        }

    def audit_session(self, user_id_hash: str, session_id: str) -> dict[str, Any]:
        summary = self.summarize_session(user_id_hash, session_id)
        session = self.store.get_document("voice_sessions", session_id)

        if not session or session.get("user_id_hash") != user_id_hash:
            return {
                **summary,
                "session": {"session_id": session_id, "user_id_hash": user_id_hash, "status": "missing"},
                "risk": {"max_risk_band": None, "danger_kind": None, "risk_reports": 0},
                "timeline": [],
            }

        session_record = dict(session)
        session_events = self.telemetry.events_for_session(user_id_hash, session_id)
        risk_events = [event for event in session_events if str(event.get("event") or "").startswith("voice.safety")]

        risk_bands = [
            str((event.get("metadata") or {}).get("band") or "")
            for event in risk_events
            if (event.get("metadata") or {}).get("band")
        ]
        danger_kinds = [
            str((event.get("metadata") or {}).get("danger_kind") or session_record.get("danger_kind") or "")
            for event in risk_events
            if (event.get("metadata") or {}).get("danger_kind") or session_record.get("danger_kind")
        ]
        risk_values = [
            float((event.get("metadata") or {}).get("risk", 0.0))
            for event in risk_events
            if isinstance((event.get("metadata") or {}).get("risk"), (int, float))
        ]

        timeline = [
            {
                "event": event.get("event"),
                "source": event.get("source"),
                "reason": event.get("reason"),
                "outcome": event.get("outcome"),
                "duration_ms": int(event.get("duration_ms") or 0),
                "ts": event.get("ts"),
            }
            for event in sorted(
                session_events,
                key=lambda item: float(item.get("ts") or 0.0),
            )
        ]

        audit = {
            **summary,
            "session": {
                "session_id": session_record.get("session_id") or session_id,
                "user_id_hash": session_record.get("user_id_hash") or user_id_hash,
                "status": session_record.get("status") or "unknown",
                "floor": session_record.get("floor") or "unknown",
                "session_mode": session_record.get("session_mode") or "unknown",
                "created_at": session_record.get("created_at"),
                "reserved_s": int(session_record.get("reserved_s") or 0),
                "used_s": int(session_record.get("used_s") or 0),
                "teardown_reason": _coalesce_text(session_record.get("teardown_reason")) or None,
            },
            "risk": {
                "max_risk_band": _highest_risk_band(
                    risk_bands,
                    _coalesce_text(session_record.get("last_risk_band")) or None,
                ),
                "danger_kind": danger_kinds[-1] if danger_kinds else _coalesce_text(session_record.get("danger_kind")) or None,
                "risk_reports": int(session_record.get("risk_reports") or 0),
                "max_risk_value": max(risk_values, default=float(session_record.get("last_risk") or 0.0)),
            },
            "events_by_name": summary.get("events_by_name", {}),
            "timeline": timeline,
        }
        return audit
