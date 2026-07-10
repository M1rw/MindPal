# backend/core/security.py

"""
Text sanitization, PII redaction, hashing, and URL validation utilities.

This module provides defense-in-depth primitives used across the entire backend:
- Input sanitization (control chars, invisible chars, unicode normalization)
- PII redaction (emails, phones, IPs, tokens, secrets)
- User-id hashing for logs (NOT an auth primitive)
- URL validation for provider safety (SSRF prevention)
- Safe truncation

Design goals:
- Preserve Arabic text and normal punctuation
- Never destroy meaning, only strip dangerous/invisible content
- Conservative: redact when uncertain
"""

from __future__ import annotations

import hashlib
import ipaddress
import re
import unicodedata
import uuid
from typing import Literal
from urllib.parse import urlparse


Locale = Literal["en", "ar", "auto"]

REQUEST_ID_PREFIX = "req"
USER_HASH_PREFIX = "usr"
REDACTED_EMAIL = "[redacted_email]"
REDACTED_PHONE = "[redacted_phone]"
REDACTED_SECRET = "[redacted_secret]"  # nosec B105
REDACTED_IP = "[redacted_ip]"

# ═══════════════════════════════════════════════════════════════
# Compiled patterns
# ═══════════════════════════════════════════════════════════════

_CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_WHITESPACE_RE = re.compile(r"[ \t\f\v]+")

# Zero-width and invisible Unicode characters that can be used for
# homoglyph attacks, invisible text injection, or watermarking.
_INVISIBLE_CHARS_RE = re.compile(
    "["
    "\u200b"  # zero-width space
    "\u200c"  # zero-width non-joiner
    "\u200d"  # zero-width joiner
    "\u200e"  # left-to-right mark
    "\u200f"  # right-to-left mark
    "\u2060"  # word joiner
    "\u2061"  # function application
    "\u2062"  # invisible times
    "\u2063"  # invisible separator
    "\u2064"  # invisible plus
    "\ufeff"  # byte order mark / zero-width no-break space
    "\ufff9"  # interlinear annotation anchor
    "\ufffa"  # interlinear annotation separator
    "\ufffb"  # interlinear annotation terminator
    "]"
)

# Matches normal emails even when followed by punctuation:
# test@example.com.
# test@example.com,
# (test@example.com)
_EMAIL_RE = re.compile(
    r"(?<![\w.+-])"
    r"(?:[A-Z0-9._%+-]{1,64}@(?:[A-Z0-9-]{1,63}\.)+[A-Z]{2,63})"
    r"(?![A-Z0-9-])",
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

# Conservative token-looking value. Requires both letters and digits to avoid
# redacting ordinary long words.
_LONG_TOKEN_RE = re.compile(
    r"\b(?=[A-Za-z0-9._~+/=-]*[A-Za-z])"
    r"(?=[A-Za-z0-9._~+/=-]*\d)"
    r"[A-Za-z0-9._~+/=-]{24,}\b"
)

# IPv4 addresses — matches dotted-quad format (1.2.3.4 through 255.255.255.255).
# Requires word boundaries to avoid matching version numbers inside longer text.
_IPV4_RE = re.compile(
    r"(?<!\d\.)"
    r"(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}"
    r"(?:25[0-5]|2[0-4]\d|[01]?\d\d?)"
    r"(?!\.\d)"
)

# URL scheme whitelist for provider URL validation.
_SAFE_URL_SCHEMES = frozenset({"https", "http"})

# Private/reserved IPv4 ranges (for SSRF prevention).

# ═══════════════════════════════════════════════════════════════
# Public API
# ═══════════════════════════════════════════════════════════════

def generate_request_id() -> str:
    """
    Generate a collision-resistant request id suitable for logs and responses.
    """
    return f"{REQUEST_ID_PREFIX}_{uuid.uuid4().hex}"


def hash_user_id(user_id: str) -> str:
    """
    Return a stable non-reversible user identifier for logs and metrics.

    Security note:
        This is NOT an authentication primitive. It only reduces raw user-id
        exposure in logs and database keys. Do not use this for session tokens,
        password hashing, or access control.

        The hash is deterministic (same input → same output) by design, so it
        can be used as a stable document key in Firestore.
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

    Processing order:
    1. Unicode NFC normalization
    2. Line ending normalization (CRLF/CR → LF)
    3. Control character removal (keeps TAB, LF)
    4. Invisible/zero-width character removal
    5. Horizontal whitespace collapse per line
    6. Truncation

    Preserves Arabic text, normal punctuation, and newlines.
    """
    normalized = unicodedata.normalize("NFC", str(text or ""))
    normalized = normalized.replace("\r\n", "\n").replace("\r", "\n")
    normalized = _CONTROL_CHARS_RE.sub("", normalized)
    normalized = _INVISIBLE_CHARS_RE.sub("", normalized)

    lines: list[str] = []
    for line in normalized.split("\n"):
        lines.append(_WHITESPACE_RE.sub(" ", line).strip())

    cleaned = "\n".join(lines).strip()
    return safe_truncate(cleaned, max_chars)


def strip_invisible_chars(text: str) -> str:
    """
    Remove zero-width and invisible Unicode characters from text.

    Use this as a composable utility when full sanitization isn't needed
    but invisible character stripping is required (e.g., comparing keys).
    """
    return _INVISIBLE_CHARS_RE.sub("", str(text or ""))


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

    Targets:
    - Email addresses
    - Phone numbers (9+ digits)
    - Bearer tokens
    - Key=value secrets (api_key, token, password, etc.)
    - Long alphanumeric tokens (24+ chars with mixed letters/digits)
    - IPv4 addresses

    This is a basic redaction layer, not a full DLP engine.
    It is designed for logs, memory payloads, prompt payloads, and persistence
    safety. It preserves Arabic text and normal sentence structure.
    """
    value = str(text or "")

    value = _EMAIL_RE.sub(REDACTED_EMAIL, value)
    value = _BEARER_RE.sub(REDACTED_SECRET, value)
    value = _KEY_VALUE_SECRET_RE.sub(
        lambda match: f"{match.group(1)}={REDACTED_SECRET}",
        value,
    )
    # IPv4 must run BEFORE phone — the phone regex also matches dotted-quad IPs.
    value = _IPV4_RE.sub(_redact_ip_match, value)
    value = _PHONE_LIKE_RE.sub(_redact_phone_match, value)
    value = _LONG_TOKEN_RE.sub(REDACTED_SECRET, value)

    return value


def safe_truncate(text: str, max_chars: int) -> str:
    """
    Truncate text safely with an ellipsis when possible.

    Handles edge cases:
    - Negative or zero max_chars → empty string
    - Non-integer max_chars → clamped to int
    - max_chars == 1 → single ellipsis
    """
    try:
        limit = max(0, int(max_chars))
    except (TypeError, ValueError, OverflowError):
        return ""

    if limit <= 0:
        return ""

    value = str(text or "")
    if len(value) <= limit:
        return value

    if limit == 1:
        return "…"

    return value[: limit - 1].rstrip() + "…"


def validate_url(
    url: str,
    *,
    allowed_schemes: frozenset[str] | None = None,
    block_private_ips: bool = True,
    max_length: int = 2048,
) -> str:
    """
    Validate and sanitize a URL for safe use in provider HTTP calls.

    Checks:
    - Scheme whitelist (default: http, https)
    - URL length limit
    - No private/reserved IP addresses (SSRF prevention)
    - Non-empty hostname

    Returns the cleaned URL string.
    Raises ValueError if the URL is unsafe.
    """
    schemes = allowed_schemes or _SAFE_URL_SCHEMES

    cleaned = sanitize_text(str(url or ""), max_length).strip()
    if not cleaned:
        raise ValueError("URL is empty")

    try:
        parsed = urlparse(cleaned)
    except Exception as exc:
        raise ValueError(f"URL parse error: {exc}") from exc

    if not parsed.scheme or parsed.scheme.lower() not in schemes:
        raise ValueError(
            f"URL scheme '{parsed.scheme}' not in allowed schemes: {sorted(schemes)}"
        )

    hostname = (parsed.hostname or "").strip().lower()
    if not hostname:
        raise ValueError("URL has no hostname")

    if block_private_ips:
        if hostname == "localhost" or hostname.endswith(".localhost"):
            raise ValueError(f"URL hostname '{hostname}' is a loopback address")
        try:
            address = ipaddress.ip_address(hostname.strip("[]"))
        except ValueError:
            address = None
        if address is not None and not address.is_global:
            raise ValueError(f"URL hostname '{hostname}' is not globally routable")

    return cleaned


# ═══════════════════════════════════════════════════════════════
# Internal helpers
# ═══════════════════════════════════════════════════════════════

def _redact_phone_match(match: re.Match[str]) -> str:
    candidate = match.group(0)
    digit_count = sum(char.isdigit() for char in candidate)

    # Avoid redacting short IDs/dates while still catching common phone formats.
    if digit_count < 9:
        return candidate

    return REDACTED_PHONE


def _redact_ip_match(match: re.Match[str]) -> str:
    """Redact an IPv4 address, but skip common non-IP patterns like version numbers."""
    candidate = match.group(0)
    octets = candidate.split(".")

    # A valid IP has exactly 4 octets, all 0-255.
    if len(octets) != 4:
        return candidate

    try:
        values = [int(o) for o in octets]
    except ValueError:
        return candidate

    # Skip 0.0.0.0 and common version-like patterns (all octets < 10 and first is 0-3).
    if all(v < 10 for v in values) and values[0] <= 3:
        return candidate

    return REDACTED_IP


__all__ = [
    "Locale",
    "REDACTED_EMAIL",
    "REDACTED_IP",
    "REDACTED_PHONE",
    "REDACTED_SECRET",
    "generate_request_id",
    "hash_user_id",
    "normalize_locale",
    "redact_basic_pii",
    "safe_truncate",
    "sanitize_text",
    "strip_invisible_chars",
    "validate_url",
]