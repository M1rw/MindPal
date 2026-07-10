# backend/core/settings_helpers.py

"""
Shared settings-access helpers for backend services.

All configuration reads should go through these helpers, which:
1. Read from the pydantic Settings object first (validated, typed)
2. Safely unwrap SecretStr values
3. Provide typed bool/float/str accessors

This eliminates the ~280 lines of duplicated _setting_value/_setting_bool/
_is_production helpers that were copy-pasted across 8 service files.
"""

from __future__ import annotations

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


def setting_bool(settings: Any, name: str, *, default: bool) -> bool:
    """Read a boolean configuration value with explicit default."""
    value = setting_value(settings, name, None)

    if value is None:
        return default

    if isinstance(value, bool):
        return value

    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def setting_float(settings: Any, name: str, *, default: float) -> float:
    """Read a float configuration value with explicit default."""
    value = setting_value(settings, name, default)

    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def is_production(settings: Any) -> bool:
    """Check if the current environment is production."""
    # Use the Settings property if available (preferred)
    if hasattr(settings, "is_production"):
        return settings.is_production

    value = setting_value(settings, "ENVIRONMENT", "development")
    environment = sanitize_text(str(value or "development"), 80).lower()
    return environment in {"production", "prod"}
