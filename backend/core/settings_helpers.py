# backend/core/settings_helpers.py

"""
Shared settings-access helpers for backend services.

All configuration reads should go through these helpers, which:
1. Read from the pydantic Settings object first (validated, typed)
2. Safely unwrap SecretStr values
3. Provide typed bool/float/int/json/list accessors

This eliminates duplicated _setting_value/_setting_bool/
_is_production helpers across backend service files.
"""

from __future__ import annotations

import json
from typing import Any

from backend.core.security import sanitize_text


def setting_value(settings: Any, name: str, default: Any = None) -> Any:
    """
    Read a configuration value from the validated Settings object.
    """
    value = getattr(settings, name, None)

    if value is None:
        return default

    if hasattr(value, "get_secret_value"):
        return value.get_secret_value()

    return value


def setting_str(settings: Any, name: str, default: str = "") -> str:
    """Read a string configuration value, sanitized to 1000 chars."""
    value = setting_value(settings, name, default)
    return sanitize_text(str(value or ""), 1_000)


def setting_secret_str(settings: Any, name: str, default: str = "") -> str:
    """Read a secret string value, unwrapping SecretStr if needed."""
    value = setting_value(settings, name, default)

    if value is None:
        return default

    if hasattr(value, "get_secret_value"):
        value = value.get_secret_value()

    return str(value or default).strip()


def parse_bool_setting(settings: Any, name: str, default: bool = False) -> bool:
    """Read a boolean configuration value with explicit default."""
    value = setting_value(settings, name, None)

    if value is None:
        return default

    if isinstance(value, bool):
        return value

    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def parse_float_setting(settings: Any, name: str, default: float = 0.0) -> float:
    """Read a float configuration value with explicit default."""
    value = setting_value(settings, name, default)

    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def parse_int_setting(settings: Any, name: str, default: int = 0) -> int:
    """Read an integer configuration value with explicit default."""
    value = setting_value(settings, name, default)

    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def parse_json_setting(settings: Any, name: str, default: Any = None) -> Any:
    """Read and parse a JSON string setting value with fallback."""
    value = setting_value(settings, name, None)
    if value is None:
        return default
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        try:
            return json.loads(value)
        except Exception:
            return default
    return default


def parse_string_list_setting(
    settings: Any,
    name: str,
    default: list[str] | None = None,
) -> list[str]:
    """Read a comma-separated or sequence string list configuration value."""
    fallback = default if default is not None else []
    value = setting_value(settings, name, None)

    if value is None:
        return fallback

    if isinstance(value, str):
        raw_items = value.split(",")
    elif isinstance(value, (list, tuple, set, frozenset)):
        raw_items = list(value)
    else:
        return fallback

    cleaned = [
        sanitize_text(str(item), 300)
        for item in raw_items
        if sanitize_text(str(item), 300)
    ]

    return cleaned or fallback


# Standard accessor aliases
setting_bool = parse_bool_setting
setting_float = parse_float_setting
setting_int = parse_int_setting


def is_production(settings: Any) -> bool:
    """Check if the current environment is production."""
    if hasattr(settings, "is_production"):
        return settings.is_production

    value = setting_value(settings, "ENVIRONMENT", "development")
    environment = sanitize_text(str(value or "development"), 80).lower()
    return environment in {"production", "prod"}
