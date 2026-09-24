"""Deterministic reply-shape scoring: does a reply fit the message it answers?

A judge model grades meaning (specificity, warmth, safety). This grades the
things a person notices before they read a word: a wall of text for "hi", five
paragraphs of blank lines, three questions, emoji on grief, stock sympathy
("Take your time. I'm listening."), bullets in a feelings chat, English back to
Arabic. Every factor is 0-1; `score` is their weighted mean on 0-100.
No network, so it runs in CI against recorded or live replies.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional

_WORD = re.compile(r"[\w؀-ۿ']+", re.UNICODE)
_ARABIC = re.compile(r"[؀-ۿ]")
_LATIN = re.compile(r"[A-Za-z]")
_EMOJI = re.compile(
    "[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F000-\U0001F2FF\U00002B50\U00002764\U0000FE0F]"
)
_HEADER = re.compile(r"^\s{0,3}#{1,6}\s", re.MULTILINE)
_BULLET = re.compile(r"^\s{0,3}(?:[-*•]|\d+[.)])\s", re.MULTILINE)
_BOLD = re.compile(r"\*\*[^*]+\*\*")
_BLANK_RUN = re.compile(r"\n\s*\n\s*\n")

# Filler a person has read a hundred times. Matched anywhere, case-insensitive.
STOCK_PHRASES = (
    r"i'?m (?:always )?here (?:for you|with you|to listen)",
    r"i'?m listening",
    r"take (?:all )?(?:the )?time you need",
    r"take your time",
    r"(?:it'?s|that'?s) (?:completely |totally |perfectly )?(?:okay|ok|valid|understandable|normal) to feel",
    r"your feelings are valid",
    r"you'?re not alone",
    r"i hear you",
    r"it sounds like you'?re",
    r"that sounds (?:really |incredibly |so )?(?:hard|tough|difficult|overwhelming|frustrating|painful)",
    r"that must be (?:really |so )?(?:hard|tough|difficult)",
    r"be (?:gentle|kind) (?:with|to) yourself",
    r"remember(?:,)? (?:that )?(?:you|it'?s)",
    r"sending (?:you )?(?:hugs|love|warmth)",
    r"there'?s no (?:right|wrong) (?:way|answer)",
    r"thank you for (?:sharing|opening up|trusting)",
    r"what a (?:beautiful|wonderful|lovely) ",
    r"i'?m so (?:sorry|glad) (?:to hear|you)",
    r"whenever you'?re ready",
    r"no pressure",
    r"one step at a time",
    r"as an ai",
    # Arabic stock comfort.
    r"انا هنا (?:عشانك|لك|معك)",
    r"مشاعرك (?:مهمه|مهمة|طبيعيه|طبيعية|مفهومه|مفهومة)",
    r"خذ وقتك",
    r"خذي وقتك",
    r"لست وحدك",
    r"انت مش لوحدك",
)
_STOCK = [re.compile(p, re.IGNORECASE) for p in STOCK_PHRASES]

# Weighted: shape problems a person feels most count most.
WEIGHTS: Dict[str, float] = {
    "length_fit": 3.0,
    "paragraphs": 2.0,
    "no_stock": 2.0,
    "questions": 1.5,
    "emoji": 1.0,
    "markdown": 1.0,
    "language": 2.0,
    "whitespace": 1.0,
}


def words(text: str) -> int:
    return len(_WORD.findall(text or ""))


def is_arabic(text: str) -> bool:
    return len(_ARABIC.findall(text or "")) > len(_LATIN.findall(text or ""))


def length_budget(message: str, *, category: str = "", detailed: bool = False) -> tuple[int, int]:
    """Words a good reply to this message would use: (comfortable max, hard max).

    Scales with what they wrote and what they asked for. A two-word greeting
    earns a sentence or two; a long story or a request for options earns more.
    """
    n = words(message)
    asks_for_more = category in {"advice", "distress_and_advice", "long_story", "question"} or bool(
        re.search(r"\b(options|steps|plan|explain|how (?:do|can) i|what should i|ideas|tips)\b", message, re.I)
    )
    if n <= 4:
        soft, hard = 30, 55
    elif n <= 15:
        soft, hard = 60, 100
    elif n <= 60:
        soft, hard = 100, 160
    else:
        soft, hard = 150, 230
    if asks_for_more:
        soft, hard = soft + 60, hard + 90
    if detailed:
        soft, hard = int(soft * 1.6), int(hard * 1.6)
    return soft, hard


def _ramp(value: float, good: float, bad: float) -> float:
    """1 at or below `good`, 0 at or above `bad`, linear between."""
    if value <= good:
        return 1.0
    if value >= bad:
        return 0.0
    return round(1 - (value - good) / (bad - good), 3)


@dataclass
class ReplyScore:
    score: float
    factors: Dict[str, float]
    stats: Dict[str, object]
    flags: List[str] = field(default_factory=list)


def score_reply(
    message: str,
    reply: str,
    *,
    category: str = "",
    crisis: bool = False,
    detailed: bool = False,
    heavy: Optional[bool] = None,
) -> ReplyScore:
    # Models write curly apostrophes; the phrase list is written with straight ones.
    text = (reply or "").replace("’", "'").replace("‘", "'").strip()
    n_words = words(text)
    soft, hard = length_budget(message, category=category, detailed=detailed)
    paragraphs = [p for p in re.split(r"\n\s*\n", text) if p.strip()]
    questions = text.count("?") + text.count("؟")
    emoji = len(_EMOJI.findall(text))
    stock = sorted({m.group(0).lower() for p in _STOCK for m in p.finditer(text)})
    headers = len(_HEADER.findall(text))
    bullets = len(_BULLET.findall(text))
    bold = len(_BOLD.findall(text))
    short_input = words(message) <= 15
    heavy = bool(heavy) if heavy is not None else category in {"venting", "crisis", "distortion", "trajectory"}

    max_paragraphs = 1 if words(message) <= 4 else (2 if short_input else 3)
    if detailed or category in {"advice", "long_story", "distress_and_advice"}:
        max_paragraphs += 2

    factors: Dict[str, float] = {
        "length_fit": _ramp(n_words, soft, hard) if not crisis else 1.0,
        "paragraphs": _ramp(len(paragraphs), max_paragraphs, max_paragraphs + 3) if not crisis else 1.0,
        "no_stock": _ramp(len(stock), 0, 3),
        "questions": _ramp(questions, 1, 3 if category == "advice" else 2.5),
        "emoji": _ramp(emoji, 0 if heavy else 1, 1 if heavy else 3),
        "markdown": 1.0 if detailed or category in {"advice", "question"} else _ramp(headers * 2 + bullets + bold * 0.5, 0, 3),
        "language": 1.0 if is_arabic(message) == is_arabic(text) or not text else 0.0,
        "whitespace": 0.0 if _BLANK_RUN.search(text) or "\\n" in text else 1.0,
    }
    total = sum(WEIGHTS.values())
    score = round(100 * sum(factors[k] * w for k, w in WEIGHTS.items()) / total, 1)
    flags = [name for name, value in factors.items() if value < 0.5]
    return ReplyScore(
        score=score,
        factors=factors,
        stats={
            "words": n_words,
            "budget": [soft, hard],
            "paragraphs": len(paragraphs),
            "questions": questions,
            "emoji": emoji,
            "stock": stock,
            "markdown": {"headers": headers, "bullets": bullets, "bold": bold},
        },
        flags=flags,
    )
