# backend/domain/safety/classify.py — Safety Classification Domain
#
# Keyword matching for HTTP chat safety. This is not clinical screening and not a
# risk assessment: it is a conservative trigger for stopping generation and handing
# the person real crisis resources. It will miss disclosures and it will occasionally
# stop a conversation that was not a crisis. Both are acceptable; silently continuing
# through a disclosure is not.
#
# Live voice does not use this lexicon as the stay/escalate authority. That path is
# `backend/domain/safety/voice_classify.py` (Gemini JSON on the cumulative transcript).
# Patterns below remain for chat, and are written against `normalize_for_safety`.

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import List, Optional, Tuple

CRISIS_RESPONSE = (
    "If you are feeling overwhelmed or having thoughts of self-harm, please know that help is available. "
    "You can connect with compassionate, trained professionals immediately:\n\n"
    "• **National Suicide and Crisis Lifeline (US):** Call or text 988\n"
    "• **Crisis Text Line:** Text HOME to 741741\n"
    "• **International Emergency Services:** Please contact your local emergency response service or nearest crisis line.\n\n"
    "I am here to listen and support you, but please reach out to these crisis resources right now for immediate help."
)

_ARABIC_DIACRITICS = re.compile(r"[\u064B-\u0652\u0670\u0640]")
_ARABIC_FOLD = str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ى": "ي", "ئ": "ي", "ؤ": "و", "ة": "ه"})
_PUNCT = re.compile(r"[^\w\s\u0600-\u06FF]+", re.UNICODE)
_WS = re.compile(r"\s+")


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
_SELF = r"my\s*self"
_NEG = r"(?:dont|do\s*not|doesnt|cant|can\s*not|wont|will\s*not)"
# Arabic has no word boundary Python can use, and the collisions are real:
# "نفسي" (myself) is a prefix of "نفسيتي" (my mood), so "بيقتل نفسيتي" ("it kills
# my mood") must not read as a disclosure.
_AR_END = r"(?![\u0621-\u064A])"

_CRISIS_PATTERNS: List[str] = [
    # --- English: act on self ---
    rf"\bkill(?:ing|ed)?\s*{_SELF}\b",
    rf"\b(?:off|offing)\s*{_SELF}\b",
    rf"\bhurt(?:ing)?\s*{_SELF}\b",
    rf"\bharm(?:ing)?\s*{_SELF}\b",
    rf"\bcut(?:ting)?\s*{_SELF}\b",
    rf"\bhang(?:ing)?\s*{_SELF}\b",
    rf"\bstab(?:bing)?\s*{_SELF}\b",
    rf"\bself\s*harm(?:ing|ed)?\b",
    r"\bsl(?:it|itting)\s*my\s*wrists?\b",
    r"\bcut(?:ting)?\s*my\s*wrists?\b",
    r"\boverdos(?:e|ed|ing)\b",
    r"\bsuicid(?:e|al)\b",
    # --- English: ending life ---
    r"\bend(?:ing)?\s*my\s*life\b",
    r"\bend(?:ing)?\s*it\s*all\b",
    r"\btak(?:e|ing)\s*my\s*own\s*life\b",
    # --- English: wanting to be dead ---
    r"\b(?:want(?:ed|ing)?\s*to|wanna|wana)\s*die\b",
    r"\bwish\s*(?:i|id)\s*(?:was|were|wasnt|am)\s*dead\b",
    r"\bwish\s*i\s*(?:could|would)\s*die\b",
    r"\b(?:better\s*off|rather\s*be|want\s*to\s*be)\s*dead\b",
    rf"\b{_NEG}\s*want\s*to\s*(?:live|be\s*alive|wake\s*up\s*(?:again|tomorrow))\b",
    rf"\b{_NEG}\s*want\s*to\s*be\s*here\s*any\s*more\b",
    r"\bno\s*(?:reason|point)\s*(?:to|in|of)?\s*liv(?:e|ing)\b",
    r"\bno\s*point\s*being\s*(?:here|alive)\b",
    # --- Arabic: act on self (verb prefixes vary, so no leading boundary) ---
    r"انتحار",
    r"انتحر",
    rf"قتل\s*(?:نفسي|حالي){_AR_END}",
    rf"شنق\s*(?:نفسي|حالي){_AR_END}",
    rf"ايذاء\s*(?:نفسي|النفس){_AR_END}",
    rf"(?:اذي|اوذي|اجرح|جرح)\s*(?:نفسي|حالي){_AR_END}",
    r"جرعه\s*زايده",
    # --- Arabic: ending life / wanting to be dead ---
    rf"(?:انهي|انهاء|اخلص\s*من)\s*حياتي{_AR_END}",
    rf"(?:ابي|بدي|عايز|عاوز|اريد|نفسي|ودي|بغيت|حاب)\s*(?:ان\s*)?اموت{_AR_END}",
    rf"(?:ما\s*بدي|مابدي|مش\s*عايز|مش\s*عاوز|لا\s*اريد|ما\s*ابي|ما\s*اريد)\s*(?:ان\s*)?اعيش{_AR_END}",
]

# Idioms that contain a crisis phrase but are not a disclosure. These also stop the
# model's *own* safety script from tripping the output-side classifier in live voice,
# which would otherwise freeze a call for saying the word "lifeline".
_BENIGN_PATTERNS: List[str] = [
    rf"\bkill(?:ing)?\s*{_SELF}\s*laughing\b",
    r"\b(?:want(?:ed)?\s*to|wanna)\s*die\s*(?:laughing|of\s*(?:laughter|embarrassment|shame))\b",
    r"\boverdos(?:e|ed|ing)\s*(?:on|of)\s*(?:caffeine|coffee|sugar|chocolate|candy|carbs|cake|vitamins?)\b",
    r"\bsuicide\s*(?:and\s*crisis\s*)?(?:lifeline|hotline|help\s*line|helpline|prevention|squad)\b",
    r"\bnational\s*suicide\b",
    r"\bsuicide\s*prevention\b",
    r"خط\s*(?:الدعم|المساعده|الطوارئ)",
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
                crisis_response=CRISIS_RESPONSE,
            )

        return SafetyCheckResult(is_crisis=False, risk_level="none")
