# backend/core/errors.py

from __future__ import annotations

from typing import Any


class AppError(Exception):
    """Domain error keyed by contracts/errors.yaml.

    `message` is what the caller sees. `internal_message` is what the code and
    the logs see, and may carry provider text, endpoints and status names that
    must not cross the wire — an upstream error string can name the project,
    the model, quota state, or the shape of a credential. Domain code that
    matches on provider wording (the Live setup-field probes, for instance)
    reads `internal_message`; everything user-facing reads `message`.
    """

    def __init__(
        self,
        code: str,
        message: str = "",
        *,
        details: dict[str, Any] | None = None,
        internal_message: str | None = None,
    ) -> None:
        self.code = code
        self.message = message
        self.internal_message = internal_message or message
        self.details = details or {}
        super().__init__(self.internal_message or code)
