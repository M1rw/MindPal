# backend/services/domain/safety/protocols.py

from __future__ import annotations

from typing import Protocol, runtime_checkable
from backend.models.safety import SafetyDecision


@runtime_checkable
class SafetyClassifier(Protocol):
    """
    Protocol defining the contract for deterministic or hybrid safety classifiers.
    """

    def classify_input(self, text: str, locale: str | None = "auto") -> SafetyDecision:
        """
        Evaluate input text against safety policies and return a SafetyDecision.

        Args:
            text: Input message or prompt text to analyze.
            locale: Optional locale string for localized safety rules.

        Returns:
            SafetyDecision domain object containing risk level and matched rules.
        """
        ...
