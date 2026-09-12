# backend/domain/safety/classify.py — Safety Classification Domain

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

_CRISIS_KEYWORDS = [
    r"\bsuicide\b", r"\bkill myself\b", r"\bend my life\b", r"\bending my life\b",
    r"\bself-harm\b", r"\bcutting myself\b", r"\boverdose\b",
    r"\bانتحار\b", r"\bانهاء حياتي\b", r"\bايذاء نفسي\b"
]

_CRISIS_REGEX = re.compile("|".join(_CRISIS_KEYWORDS), re.IGNORECASE)


@dataclass(frozen=True, slots=True)
class SafetyCheckResult:
    is_crisis: bool
    risk_level: str  # "none", "moderate", "imminent"
    trigger_reason: Optional[str] = None
    crisis_response: Optional[str] = None


class SafetyService:
    """Deterministic Safety & Crisis Detector."""

    def classify_message(self, text: str) -> SafetyCheckResult:
        if not text:
            return SafetyCheckResult(is_crisis=False, risk_level="none")

        match = _CRISIS_REGEX.search(text)
        if match:
            return SafetyCheckResult(
                is_crisis=True,
                risk_level="imminent",
                trigger_reason=match.group(0),
                crisis_response=(
                    "If you are feeling overwhelmed or having thoughts of self-harm, please know that help is available. "
                    "You can connect with compassionate, trained professionals immediately:\n\n"
                    "• **National Suicide and Crisis Lifeline (US):** Call or text 988\n"
                    "• **Crisis Text Line:** Text HOME to 741741\n"
                    "• **International Emergency Services:** Please contact your local emergency response service or nearest crisis line.\n\n"
                    "I am here to listen and support you, but please reach out to these crisis resources right now for immediate help."
                ),
            )

        return SafetyCheckResult(is_crisis=False, risk_level="none")
