# backend/services/domain/safety/protocols.py

from __future__ import annotations

from typing import Protocol, runtime_checkable
from backend.models.safety import SafetyDecision


@runtime_checkable
class SafetyClassifier(Protocol):
    """Protocol for safety classifiers."""

    def classify_input(self, text: str, locale: str | None = "auto") -> SafetyDecision:
        ...
