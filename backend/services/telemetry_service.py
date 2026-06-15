import json
import logging
from datetime import datetime, UTC
from typing import Any

from backend.models.user import UserSession, UserProfile
from backend.core.security import hash_user_id

# Configure a structured logger specifically for telemetry
telemetry_logger = logging.getLogger("mindpal.telemetry")
telemetry_logger.setLevel(logging.INFO)

class TelemetryService:
    """
    Handles anonymized product quality signals to improve MindPal over time.
    Never logs raw private memory or chat messages.
    """

    def __init__(self, session: UserSession, profile: UserProfile | None):
        self.session = session
        self.profile = profile

    def _can_log(self) -> bool:
        """Check if the user has opted in to product improvement."""
        if not self.profile:
            return False
        return self.profile.preferences.safety.allow_product_improvement

    def log_quality_signal(self, event_name: str, payload: dict[str, Any]) -> None:
        """
        Logs a sanitized, anonymized quality signal if the user has opted in.
        """
        if not self._can_log():
            return

        # Double-check: ensure no "message", "memory", or "text" keys leak in
        sanitized_payload = {
            k: v for k, v in payload.items() 
            if k not in ("message", "memory", "text", "raw_user_id", "email", "phone")
        }

        # Anonymize user identity by hashing the session's user_id_hash again with a salt
        # to ensure it cannot be linked back to the main DB user hash
        anonymous_id = hash_user_id(self.session.user_id_hash + "_telemetry_salt")

        log_entry = {
            "timestamp": datetime.now(UTC).isoformat(),
            "event": event_name,
            "anonymous_id": anonymous_id,
            "locale": self.session.locale,
            "channel": self.session.channel.value,
            **sanitized_payload
        }

        # Emit as a single JSON line to standard output for Datadog/Vercel ingestion
        telemetry_logger.info(json.dumps(log_entry))

    def log_latency(self, component: str, duration_ms: float) -> None:
        """Log performance metrics."""
        self.log_quality_signal("latency", {"component": component, "duration_ms": duration_ms})

    def log_rag_retrieval(self, num_results: int, top_score: float, fallback_triggered: bool) -> None:
        """Log RAG effectiveness without the actual content."""
        self.log_quality_signal("rag_retrieval", {
            "num_results": num_results,
            "top_score": top_score,
            "fallback_triggered": fallback_triggered
        })

    def log_llm_usage(self, provider: str, prompt_tokens: int, completion_tokens: int) -> None:
        """Log LLM token usage."""
        self.log_quality_signal("llm_usage", {
            "provider": provider,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens
        })
