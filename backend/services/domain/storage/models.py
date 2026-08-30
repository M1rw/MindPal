# Storage domain models

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class StorageDocument:
    """Normalized storage document."""
    collection: str
    key: str
    payload: dict[str, Any]
    created_at: str | None = None
    updated_at: str | None = None


@dataclass(frozen=True, slots=True)
class StorageQuery:
    """Generic storage query descriptor."""
    collection: str
    key: str | None = None
    limit: int = 25
    offset: int = 0
    filters: dict[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class StorageHealth:
    """Health response for storage provider."""
    provider: str
    configured: bool
    mock_mode: bool
    production_mode: bool
    firebase_required: bool
    firebase_init_error: str | None = None
