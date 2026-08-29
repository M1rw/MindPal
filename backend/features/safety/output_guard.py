# backend/features/safety/output_guard.py

"""
Outbound LLM response clinical boundary guard and PII scrubber.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from backend.core.config import Settings, get_settings
from backend.core.security import redact_basic_pii, sanitize_text
from .schemas import OutputGuardDecision

logger = logging.getLogger(__name__)

_DIAGNOSTIC_PATTERNS = (
    re.compile(r"\b(?:you have|i diagnose you with|you are suffering from)\s+(?:major depression|bipolar|schizophrenia|bpd|ptsd)\b", re.IGNORECASE),
    re.compile(r"\b(?:أشخصك بـ|أنت تعاني رسميا من مرض)\b", re.IGNORECASE),
)

_MEDICATION_PATTERNS = (
    re.compile(r"\b(?:take|increase your dose of|stop taking|prescribe)\s+(?:prozac|zoloft|lexapro|xanax|adderall|sertraline)\b", re.IGNORECASE),
    re.compile(r"\b(?:خذ دواء|تناول جرعة|أوقف دواء)\b", re.IGNORECASE),
)

_THERAPIST_ASSERTIONS = (
    re.compile(r"\b(?:as your therapist|i am your therapist|in our clinical sessions)\b", re.IGNORECASE),
    re.compile(r"\b(?:أنا معالجك النفسي|بصفتي معالجك)\b", re.IGNORECASE),
)


class OutputGuardService:
    """Sanitizes and enforces clinical safety constraints on outbound LLM text."""

    def __init__(self, *, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()

    async def inspect_and_sanitize(self, response_text: str) -> OutputGuardDecision:
        cleaned = sanitize_text(response_text, 12_000)
        violations: list[str] = []

        has_diag = any(pat.search(cleaned) for pat in _DIAGNOSTIC_PATTERNS)
        if has_diag:
            violations.append("diagnostic_claim")

        has_med = any(pat.search(cleaned) for pat in _MEDICATION_PATTERNS)
        if has_med:
            violations.append("medication_advice")

        has_therapist = any(pat.search(cleaned) for pat in _THERAPIST_ASSERTIONS)
        if has_therapist:
            violations.append("therapist_assertion")

        sanitized_text = redact_basic_pii(cleaned)
        pii_scrubbed = sanitized_text != cleaned

        is_safe = not (has_diag or has_med or has_therapist)

        rewritten = sanitized_text
        if not is_safe:
            rewritten = self._apply_safe_boundary_rewrite(sanitized_text, has_diag=has_diag, has_med=has_med, has_therapist=has_therapist)

        return OutputGuardDecision(
            safe=is_safe,
            rewritten_text=rewritten,
            violations=violations,
            contains_diagnostic_claim=has_diag,
            contains_medication_advice=has_med,
            contains_therapist_assertion=has_therapist,
            pii_redacted=pii_scrubbed,
        )

    def _apply_safe_boundary_rewrite(self, text: str, *, has_diag: bool, has_med: bool, has_therapist: bool) -> str:
        out = text
        for pat in _DIAGNOSTIC_PATTERNS:
            out = pat.sub("it sounds like you are experiencing symptoms that may align with", out)
        for pat in _MEDICATION_PATTERNS:
            out = pat.sub("discuss medication options with a qualified physician regarding", out)
        for pat in _THERAPIST_ASSERTIONS:
            out = pat.sub("as your wellness companion", out)
        return out
