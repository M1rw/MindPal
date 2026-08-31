"""Deterministic freshness policy for facts that must not be answered from model memory."""

from __future__ import annotations

import re
from typing import Final

from backend.core.security import sanitize_text

_VOLATILE_OFFICEHOLDER_RE: Final[re.Pattern[str]] = re.compile(
    r"\b(?:mayor|president|prime minister|governor|senator|representative|"
    r"member of parliament|mp|ceo|chair(?:man|woman)?|minister|commissioner)\b",
    re.IGNORECASE,
)
_VOLATILE_FACT_RE: Final[re.Pattern[str]] = re.compile(
    r"\b(?:current|latest|today(?:'s)?|right now|now|price|cost|weather|"
    r"score|standings?|election|officeholder)\b",
    re.IGNORECASE,
)
_VOLATILE_FACT_ARABIC_RE: Final[re.Pattern[str]] = re.compile(
    r"(?:عمدة|رئيس|رئيس الوزراء|محافظ|وزير|سعر|الطقس|نتيجة|الآن|حاليًا|اليوم)",
)


def requires_verified_web_search(user_message: str) -> bool:
    """
    Return true when current web evidence is mandatory before answering.

    This is intentionally deterministic. Model tool choice and model memory are
    not acceptable freshness controls for officeholders, changing public facts,
    prices, weather, scores, elections, or Arabic equivalents.
    """
    message = sanitize_text(user_message, 500)
    if not message:
        return False
    return bool(
        _VOLATILE_OFFICEHOLDER_RE.search(message)
        or _VOLATILE_FACT_RE.search(message)
        or _VOLATILE_FACT_ARABIC_RE.search(message)
    )
