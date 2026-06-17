# backend/models/_helpers.py

"""
Shared model utilities.

Contains helper functions that were duplicated across multiple model files
(memory.py, schemas.py, user.py). Each model file imports what it needs
from here.

No external imports — only depends on backend.core and stdlib.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any

from backend.core.security import redact_basic_pii, safe_truncate, sanitize_text


# ═══════════════════════════════════════════════════════════════
# Time
# ═══════════════════════════════════════════════════════════════

def utcnow() -> datetime:
    """Return the current UTC datetime (timezone-aware)."""
    return datetime.now(UTC)


# ═══════════════════════════════════════════════════════════════
# Metadata sanitization
# ═══════════════════════════════════════════════════════════════

def sanitize_metadata(
    value: object,
    *,
    max_items: int = 50,
    max_key_chars: int = 80,
    max_value_chars: int = 300,
    redact_pii: bool = True,
) -> dict[str, str | int | float | bool | None]:
    """
    Sanitize a metadata dict for safe storage.

    - Limits key and value lengths
    - Optionally redacts PII from string values
    - Caps total number of entries
    """
    if value is None:
        return {}

    if not isinstance(value, Mapping):
        raise TypeError("metadata must be a mapping")

    cleaned: dict[str, str | int | float | bool | None] = {}

    for raw_key, raw_value in list(value.items())[:max_items]:
        key = sanitize_text(str(raw_key or ""), max_key_chars)
        if not key:
            continue

        if raw_value is None or isinstance(raw_value, (bool, int, float)):
            cleaned[key] = raw_value
        else:
            text_value = sanitize_text(str(raw_value), max_value_chars)
            if redact_pii:
                text_value = redact_basic_pii(text_value)
                text_value = safe_truncate(text_value, max_value_chars)
            cleaned[key] = text_value

    return cleaned


# ═══════════════════════════════════════════════════════════════
# Sanitized text helpers
# ═══════════════════════════════════════════════════════════════

def sanitize_pii_text(text: str, max_chars: int) -> str:
    """Sanitize text and redact basic PII (emails, phone numbers)."""
    cleaned = sanitize_text(text, max_chars)
    cleaned = redact_basic_pii(cleaned)
    return safe_truncate(cleaned, max_chars)


def sanitize_string_list(
    value: object,
    *,
    max_items: int,
    max_item_chars: int = 180,
    redact_pii: bool = True,
) -> list[str]:
    """
    Sanitize a list of strings with deduplication.

    Accepts strings, lists, or None. Returns a deduplicated, sanitized list.
    """
    if value is None:
        return []

    if isinstance(value, str):
        raw_items: Sequence[object] = [value]
    elif isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        raw_items = value
    else:
        raw_items = [value]

    text_fn = sanitize_pii_text if redact_pii else sanitize_text

    seen: set[str] = set()
    cleaned_items: list[str] = []

    for item in raw_items:
        cleaned = text_fn(str(item or ""), max_item_chars)
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        cleaned_items.append(cleaned)
        if len(cleaned_items) >= max_items:
            break

    return cleaned_items


# ═══════════════════════════════════════════════════════════════
# UI settings sanitization (nested dicts/lists)
# ═══════════════════════════════════════════════════════════════

MAX_UI_SETTINGS_ITEMS = 80
MAX_UI_SETTINGS_VALUE_CHARS = 800

def sanitize_ui_settings(value: object) -> dict[str, Any]:
    """Sanitize nested UI settings dict (max depth 4)."""
    if not isinstance(value, Mapping):
        return {}

    cleaned: dict[str, Any] = {}

    for raw_key, raw_value in value.items():
        if len(cleaned) >= MAX_UI_SETTINGS_ITEMS:
            break

        key = sanitize_pii_text(str(raw_key or ""), 300)
        if not key:
            continue

        cleaned[key] = _sanitize_ui_setting_value(raw_value, depth=0)

    return cleaned


def _sanitize_ui_setting_value(value: object, *, depth: int) -> Any:
    """Recursively sanitize a UI setting value (max depth 4)."""
    if depth >= 4:
        return sanitize_pii_text(str(value or ""), MAX_UI_SETTINGS_VALUE_CHARS)

    if value is None or isinstance(value, bool):
        return value

    if isinstance(value, (int, float)):
        return value

    if isinstance(value, str):
        return sanitize_pii_text(value, MAX_UI_SETTINGS_VALUE_CHARS)

    if isinstance(value, Mapping):
        output: dict[str, Any] = {}
        for raw_key, raw_value in list(value.items())[:MAX_UI_SETTINGS_ITEMS]:
            key = sanitize_pii_text(str(raw_key or ""), 300)
            if key:
                output[key] = _sanitize_ui_setting_value(raw_value, depth=depth + 1)
        return output

    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [
            _sanitize_ui_setting_value(item, depth=depth + 1)
            for item in list(value)[:50]
        ]

    return sanitize_pii_text(str(value or ""), MAX_UI_SETTINGS_VALUE_CHARS)
