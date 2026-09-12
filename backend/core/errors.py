# backend/core/errors.py

from __future__ import annotations

from typing import Any


class AppError(Exception):
    """Domain error keyed by contracts/errors.yaml."""

    def __init__(self, code: str, message: str = "", *, details: dict[str, Any] | None = None) -> None:
        self.code = code
        self.message = message
        self.details = details or {}
        super().__init__(message or code)
