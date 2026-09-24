# backend/domain/safety/classify.py — Safety Classification Domain
#
# Keyword matching for HTTP chat safety. This is not clinical screening and not a
# risk assessment: it is a conservative trigger for stopping generation and handing
# the person real crisis resources. It will miss disclosures and it will occasionally
# stop a conversation that was not a crisis. Both are acceptable; silently continuing
# through a disclosure is not.
#
# Live voice does not use this lexicon as the stay/escalate authority. That path is
# `backend/domain/safety/modes/voice/classify.py` (Gemini JSON on the cumulative transcript).
# Patterns below remain for chat, and are written against `normalize_for_safety`.

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import List, Optional, Tuple

from backend.configs.runtime import safety_config

_SAFETY_CONFIG = safety_config()
CRISIS_RESPONSE = _SAFETY_CONFIG["crisis_response"]
CRISIS_RESPONSE_AR = _SAFETY_CONFIG["crisis_response_ar"]
_ARABIC_LETTER = re.compile(r"[؀-ۿ]")
_LATIN_LETTER = re.compile(r"[A-Za-z]")


def crisis_response_for(text: str) -> str:
    """Someone in crisis is answered in their own language (Arabic was getting English)."""
    arabic = len(_ARABIC_LETTER.findall(text or ""))
    return CRISIS_RESPONSE_AR if arabic > len(_LATIN_LETTER.findall(text or "")) else CRISIS_RESPONSE

_ARABIC_DIACRITICS = re.compile(_SAFETY_CONFIG["safety_normalization"]["arabic_diacritics_pattern"])
_ARABIC_FOLD = str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ى": "ي", "ئ": "ي", "ؤ": "و", "ة": "ه"})
_PUNCT = re.compile(_SAFETY_CONFIG["safety_normalization"]["punctuation_pattern"], re.UNICODE)
_WS = re.compile(_SAFETY_CONFIG["safety_normalization"]["whitespace_pattern"])


def normalize_for_safety(text: str) -> str:
    """Fold ASR output into one comparable shape: no case, no punctuation, no apostrophes.

    Arabic is folded on alef/ya/ta-marbuta so a transcript spelled أقتل or اقتل hits
    the same pattern. Spacing is preserved (not stripped) because the patterns below
    use `\\s*` where ASR is known to split a word.
    """
    if not text:
        return ""
    folded = unicodedata.normalize("NFKC", text).lower()
    folded = _ARABIC_DIACRITICS.sub("", folded).translate(_ARABIC_FOLD)
    folded = folded.replace("’", "").replace("‘", "").replace("'", "").replace("`", "")
    folded = _PUNCT.sub(" ", folded)
    return _WS.sub(" ", folded).strip()


# "myself" is the single most common ASR split in this lexicon.
_NORMALIZATION_CONFIG = _SAFETY_CONFIG["safety_normalization"]
_SELF = _NORMALIZATION_CONFIG["self_pattern"]
_NEG = _NORMALIZATION_CONFIG["negative_pattern"]
# Arabic has no word boundary Python can use, and the collisions are real:
# "نفسي" (myself) is a prefix of "نفسيتي" (my mood), so "بيقتل نفسيتي" ("it kills
# my mood") must not read as a disclosure.
_AR_END = _NORMALIZATION_CONFIG["arabic_end_pattern"]

_CRISIS_PATTERNS: List[str] = [
    pattern.format(SELF=_SELF, NEG=_NEG, AR_END=_AR_END)
    for pattern in _SAFETY_CONFIG["crisis_patterns"]
]

# Idioms that contain a crisis phrase but are not a disclosure. These also stop the
# model's *own* safety script from tripping the output-side classifier in live voice,
# which would otherwise freeze a call for saying the word "lifeline".
_BENIGN_PATTERNS: List[str] = [
    pattern.format(SELF=_SELF, NEG=_NEG, AR_END=_AR_END)
    for pattern in _SAFETY_CONFIG["benign_patterns"]
]

_CRISIS_REGEX = re.compile("|".join(_CRISIS_PATTERNS))
_BENIGN_REGEX = re.compile("|".join(_BENIGN_PATTERNS))

# Kept for callers that still import the old name.
_CRISIS_KEYWORDS = _CRISIS_PATTERNS


@dataclass(frozen=True, slots=True)
class SafetyCheckResult:
    is_crisis: bool
    risk_level: str  # "none", "moderate", "imminent"
    trigger_reason: Optional[str] = None
    crisis_response: Optional[str] = None


def crisis_evidence(text: str) -> Optional[str]:
    """Return the matched phrase from the normalized transcript, or None.

    A match inside a known benign idiom is discarded rather than escalated.
    """
    normalized = normalize_for_safety(text)
    if not normalized:
        return None
    benign_spans: List[Tuple[int, int]] = [m.span() for m in _BENIGN_REGEX.finditer(normalized)]
    for match in _CRISIS_REGEX.finditer(normalized):
        start, end = match.span()
        if any(b_start <= start and end <= b_end for b_start, b_end in benign_spans):
            continue
        return match.group(0)
    return None


class SafetyService:
    """Deterministic crisis trigger. Keyword-based, not a clinical assessment."""

    def classify_message(self, text: str) -> SafetyCheckResult:
        if not text:
            return SafetyCheckResult(is_crisis=False, risk_level="none")

        evidence = crisis_evidence(text)
        if evidence:
            return SafetyCheckResult(
                is_crisis=True,
                risk_level="imminent",
                trigger_reason=evidence,
                crisis_response=crisis_response_for(text),
            )

        return SafetyCheckResult(is_crisis=False, risk_level="none")
