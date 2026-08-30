# Auth domain models

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

MAX_AUTH_HEADER_CHARS = 8_000
MAX_RAW_USER_ID_CHARS = 160
MAX_PROVIDER_NAME_CHARS = 80
MAX_METADATA_VALUE_CHARS = 300


@dataclass(frozen=True, slots=True)
class AuthIdentity:
    """
    Sanitized authenticated identity returned by an auth provider.

    Never store:
    - bearer tokens
    - refresh tokens
    - Firebase raw payloads
    - cookies
    - provider credentials
    """

    raw_user_id: str
    provider: str
    email_verified: bool = False
    metadata: dict[str, str | int | float | bool | None] | None = None


@dataclass(frozen=True, slots=True)
class AuthResolutionMeta:
    """Metadata about auth resolution result."""
    mode: str
    authenticated: bool
    provider: str
    fallback_used: bool
    error_code: str | None = None

