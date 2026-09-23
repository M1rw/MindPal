from __future__ import annotations

import json
from typing import Any, Dict

from backend.core.errors import AppError

PROVIDER_UNAVAILABLE_MESSAGE = (
    "Live voice could not start right now. Please try again, or use dictation or text."
)


def google_mint_error_message(status: int, body: str) -> tuple[str, str]:
    """Return (google_status_class, human message) from a Gemini JSON body."""
    status_name = str(status)
    message = "Gemini did not issue a session token."
    text = (body or "").strip()
    if not text:
        return status_name, message
    try:
        data = json.loads(text)
    except ValueError:
        return status_name, text[:180]
    err = data.get("error") if isinstance(data, dict) else None
    if isinstance(err, dict):
        if err.get("status"):
            status_name = str(err["status"])
        elif err.get("code") is not None:
            status_name = str(err["code"])
        if isinstance(err.get("message"), str) and err["message"].strip():
            message = err["message"].strip()
        return status_name, message
    if isinstance(data, dict) and isinstance(data.get("message"), str) and data["message"].strip():
        return status_name, data["message"].strip()
    return status_name, text[:180]


def raise_provider_http(status: int, body: str, *, endpoint: str) -> None:
    status_name, message = google_mint_error_message(status, body)
    raise AppError(
        "unavailable",
        PROVIDER_UNAVAILABLE_MESSAGE,
        internal_message=f"Gemini {status_name}: {message[:180]}",
        details={
            "provider_status": min(status, 599),
            "provider_status_name": status_name,
            "provider_endpoint": endpoint,
        },
    )


def rejects_named_setup_field(exc: AppError, *names: str) -> bool:
    status = int(exc.details.get("provider_status") or 0)
    if status not in {400, 404}:
        return False
    message = exc.internal_message.lower()
    if not any(name.lower() in message for name in names):
        return False
    return any(hint in message for hint in ("unknown name", "invalid", "not supported", "unsupported"))


def rejects_safety_settings(exc: AppError) -> bool:
    return rejects_named_setup_field(exc, "safetySettings", "safety_settings")


def rejects_session_resumption(exc: AppError) -> bool:
    return rejects_named_setup_field(exc, "sessionResumption", "session_resumption")


def rejects_context_window_compression(exc: AppError) -> bool:
    return rejects_named_setup_field(
        exc, "contextWindowCompression", "context_window_compression", "slidingWindow"
    )


def rejects_proactivity(exc: AppError) -> bool:
    return rejects_named_setup_field(exc, "proactivity", "proactiveAudio", "proactive_audio")


def should_try_beta(exc: AppError) -> bool:
    status = int(exc.details.get("provider_status") or 0)
    name = str(exc.details.get("provider_status_name") or "")
    message = exc.internal_message.lower()
    if status in {401, 403}:
        return False
    if status == 404:
        return True
    if "unknown name" in message and "bidigeneratecontentsetup" in message:
        return False
    if status == 400 and name in {"INVALID_ARGUMENT", "FAILED_PRECONDITION"}:
        return "liveconnectconstraints" in message or "not found" in message or "api version" in message
    return status >= 500 or status == 400 and "v1alpha" in message
