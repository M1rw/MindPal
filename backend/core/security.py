# backend/core/security.py

from __future__ import annotations

import hashlib
import re
import unicodedata
import uuid
from typing import Literal


Locale = Literal["en", "ar", "auto"]

REQUEST_ID_PREFIX = "req"
USER_HASH_PREFIX = "usr"
REDACTED_EMAIL = "[redacted_email]"
REDACTED_PHONE = "[redacted_phone]"
REDACTED_SECRET = "[redacted_secret]"

_CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_WHITESPACE_RE = re.compile(r"[ \t\f\v]+")

_EMAIL_RE = re.compile(
    r"(?<![\w.+-])([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})(?![\w.+-])",
    re.IGNORECASE,
)

_PHONE_LIKE_RE = re.compile(
    r"(?<!\w)(?:\+?\d[\d\s().-]{7,}\d)(?!\w)"
)

_BEARER_RE = re.compile(
    r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}"
)

_KEY_VALUE_SECRET_RE = re.compile(
    r"(?i)\b(api[_-]?key|token|access[_-]?token|refresh[_-]?token|secret|password)"
    r"\s*[:=]\s*"
    r"(['\"]?)[A-Za-z0-9._~+/=-]{8,}\2"
)


def generate_request_id() -> str:
    """
    Generate a collision-resistant request id suitable for logs and responses.
    """
    return f"{REQUEST_ID_PREFIX}_{uuid.uuid4().hex}"


def hash_user_id(user_id: str) -> str:
    """
    Return a stable non-reversible user identifier for logs.

    This is not an authentication primitive. It only reduces raw user-id exposure
    in logs and metrics.
    """
    normalized = unicodedata.normalize("NFKC", str(user_id or "")).strip()
    if not normalized:
        normalized = "anonymous"

    digest = hashlib.blake2b(
        normalized.encode("utf-8"),
        digest_size=16,
        person=b"MindPalUserHash",
    ).hexdigest()

    return f"{USER_HASH_PREFIX}_{digest}"


def sanitize_text(text: str, max_chars: int) -> str:
    """
    Normalize and lightly sanitize user-supplied text without destroying meaning.

    Preserves Arabic and normal punctuation. Removes null/control characters,
    normalizes Unicode, trims excessive horizontal whitespace, and truncates.
    """
    normalized = unicodedata.normalize("NFC", str(text or ""))
    normalized = normalized.replace("\r\n", "\n").replace("\r", "\n")
    normalized = _CONTROL_CHARS_RE.sub("", normalized)

    lines: list[str] = []
    for line in normalized.split("\n"):
        lines.append(_WHITESPACE_RE.sub(" ", line).strip())

    cleaned = "\n".join(lines).strip()
    return safe_truncate(cleaned, max_chars)


def normalize_locale(locale: str | None) -> Locale:
    """
    Normalize caller-provided locale into supported routing values.
    """
    if not locale:
        return "auto"

    value = str(locale).strip().lower().replace("_", "-")
    if not value:
        return "auto"

    language = value.split("-", 1)[0]
    if language == "en":
        return "en"
    if language == "ar":
        return "ar"
    if language == "auto":
        return "auto"

    return "auto"


def redact_basic_pii(text: str) -> str:
    """
    Redact common PII and obvious secrets using conservative local patterns.

    This is a basic redaction layer, not a full DLP engine.
    """
    value = str(text or "")
    value = _EMAIL_RE.sub(REDACTED_EMAIL, value)
    value = _BEARER_RE.sub(REDACTED_SECRET, value)
    value = _KEY_VALUE_SECRET_RE.sub(
        lambda match: f"{match.group(1)}={REDACTED_SECRET}",
        value,
    )
    value = _PHONE_LIKE_RE.sub(_redact_phone_match, value)
    return value


def safe_truncate(text: str, max_chars: int) -> str:
    """
    Truncate text safely with an ellipsis when possible.
    """
    limit = int(max_chars)
    if limit <= 0:
        return ""

    value = str(text or "")
    if len(value) <= limit:
        return value

    if limit == 1:
        return "…"

    return value[: limit - 1].rstrip() + "…"


def _redact_phone_match(match: re.Match[str]) -> str:
    candidate = match.group(0)
    digit_count = sum(char.isdigit() for char in candidate)

    # Avoid redacting short IDs/dates while still catching common phone formats.
    if digit_count < 9:
        return candidate

    return REDACTED_PHONE