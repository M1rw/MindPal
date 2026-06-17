# backend/core/logging.py

"""
Structured JSON-lines logging for MindPal.

Design goals:
- Emit machine-readable JSON lines to stdout
- Redact sensitive field names (messages, tokens, credentials)
- Never log raw user text by default
- Safe against malformed log values (bytes, None, exceptions)
- Idempotent configuration (repeated calls are safe)
"""

from __future__ import annotations

import json
import logging as _logging
import sys
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Mapping


MAX_LOG_VALUE_CHARS = 500

# Valid Python log level names (used to whitelist _resolve_log_level input).
_VALID_LOG_LEVELS = frozenset({"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"})

SENSITIVE_FIELD_NAMES = frozenset(
    {
        "message",
        "messages",
        "raw_message",
        "user_message",
        "assistant_message",
        "content",
        "contents",
        "prompt",
        "prompts",
        "completion",
        "response",
        "responses",
        "history",
        "conversation",
        "authorization",
        "cookie",
        "set_cookie",
        "api_key",
        "apikey",
        "token",
        "access_token",
        "refresh_token",
        "secret",
        "password",
        "firebase_credentials",
        "provider_payload",
        "llm_payload",
    }
)

SENSITIVE_KEY_FRAGMENTS = (
    "api_key",
    "apikey",
    "authorization",
    "bearer",
    "cookie",
    "credential",
    "password",
    "secret",
    "token",
)


class JsonLineFormatter(_logging.Formatter):
    """
    Small JSON-lines formatter for application logs.

    It intentionally does not include record.args, raw messages, request bodies,
    provider payloads, or traceback text by default. Use event fields with stable
    metadata instead.
    """

    def format(self, record: _logging.LogRecord) -> str:
        event_name = getattr(record, "event_name", record.getMessage())
        event_fields = getattr(record, "event_fields", {})

        payload: dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "event_name": _safe_string(event_name, max_chars=120),
        }

        if isinstance(event_fields, Mapping):
            payload.update(_sanitize_log_fields(event_fields))

        if record.exc_info:
            exc_type = record.exc_info[0]
            payload["exception_type"] = exc_type.__name__ if exc_type else "Exception"

        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def configure_logging(environment: str, log_level: str = "INFO") -> None:
    """
    Configure process-wide structured logging.

    Repeated calls are safe and do not duplicate handlers.
    """

    resolved_level = _resolve_log_level(log_level)
    root_logger = _logging.getLogger()

    for handler in list(root_logger.handlers):
        root_logger.removeHandler(handler)

    handler = _logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonLineFormatter())

    root_logger.addHandler(handler)
    root_logger.setLevel(resolved_level)

    # Keep noisy third-party loggers controlled. Uvicorn can still emit through
    # root but will not duplicate through its own handlers after app startup.
    for logger_name in ("uvicorn", "uvicorn.error", "uvicorn.access", "httpx"):
        logger = _logging.getLogger(logger_name)
        logger.handlers.clear()
        logger.propagate = True
        logger.setLevel(resolved_level if environment != "production" else _logging.INFO)


def get_logger(name: str) -> _logging.Logger:
    clean_name = _safe_string(name, max_chars=120) or "mindpal"
    return _logging.getLogger(clean_name)


def log_event(logger: _logging.Logger, event_name: str, **fields: Any) -> None:
    """
    Emit one structured application event.

    Do not pass raw user text. If a caller accidentally passes common raw-text
    field names such as message/content/prompt/history, they are redacted.
    """

    clean_event_name = _safe_string(event_name, max_chars=120) or "event"
    logger.info(
        clean_event_name,
        extra={
            "event_name": clean_event_name,
            "event_fields": _sanitize_log_fields(fields),
        },
    )


# ═══════════════════════════════════════════════════════════════
# Internal helpers
# ═══════════════════════════════════════════════════════════════

def _resolve_log_level(log_level: str) -> int:
    """
    Resolve a log level string to the corresponding logging constant.

    Only accepts known level names (DEBUG, INFO, WARNING, ERROR, CRITICAL).
    Falls back to INFO for unrecognized values to prevent silent misconfiguration.
    """
    value = str(log_level or "INFO").strip().upper()
    if value in _VALID_LOG_LEVELS:
        return int(getattr(_logging, value))
    return _logging.INFO


def _sanitize_log_fields(fields: Mapping[str, Any]) -> dict[str, Any]:
    sanitized: dict[str, Any] = {}

    for raw_key, raw_value in fields.items():
        key = _safe_string(raw_key, max_chars=80)
        if not key:
            continue

        if _is_sensitive_key(key):
            sanitized[key] = "[redacted]"
            continue

        sanitized[key] = _sanitize_log_value(raw_value)

    return sanitized


def _sanitize_log_value(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value

    if isinstance(value, Enum):
        return _safe_string(value.value, max_chars=MAX_LOG_VALUE_CHARS)

    if isinstance(value, bytes):
        # Binary data in logs — show type and length only, never raw bytes.
        return f"<bytes len={len(value)}>"

    if isinstance(value, Mapping):
        return _sanitize_log_fields(value)

    if isinstance(value, (list, tuple, set, frozenset)):
        return [_sanitize_log_value(item) for item in list(value)[:50]]

    if isinstance(value, BaseException):
        return {"type": value.__class__.__name__}

    return _safe_string(value, max_chars=MAX_LOG_VALUE_CHARS)


def _is_sensitive_key(key: str) -> bool:
    normalized = key.strip().lower().replace("-", "_")
    if normalized in SENSITIVE_FIELD_NAMES:
        return True
    return any(fragment in normalized for fragment in SENSITIVE_KEY_FRAGMENTS)


def _safe_string(value: Any, *, max_chars: int) -> str:
    """
    Convert a value to a safe, single-line log string.

    Strips null bytes, carriage returns, and newlines to prevent log injection.
    """
    text = str(value).replace("\x00", "").replace("\r", " ").replace("\n", " ").strip()
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 1].rstrip() + "…"