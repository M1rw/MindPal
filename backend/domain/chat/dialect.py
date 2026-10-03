"""Egyptian Arabic: spot it in what the person writes, steer the reply toward it, and check the reply.

All deterministic: no model, no quota.

A small model asked for Egyptian Arabic tends to drift: Gulf and Levantine words
(ايش, شو, ابغى, بدي), or stiff formal Arabic (كيف حالك, ماذا). A judge model is
lenient about that, so this counts it directly. Used by the model bake-off and
usable as a free signal on live replies.

Only unambiguous markers are listed. A word Egyptians also use (كتير = a lot,
وش = a face, مرة = once, حق, كذا) is left out, so a hit is a real leak.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, List, Sequence

from backend.domain.adaptation.profile import normalize_text

# Everyday Egyptian words that other dialects and formal Arabic do not use.
_EGYPTIAN = (
    "ازاي ايه ازيك دلوقتي دلوقت عشان كده كدا اوي قوي عايز عايزه عايزين بقى برضو برضه خالص امتى فين "
    "لسه لسا مفيش اهو دي دول ده ازاى انتي ايوه ايوا طب يلا حاجه حاجات كمان مبسوط زهقان تعبان "
    "مخنوق متضايق ماشي تمام يا باشا يا غالي معلش"
).split()

# Gulf, Levantine and Hijazi markers that do not belong in an Egyptian reply.
_FOREIGN = {
    "gulf": "ايش شلون شلونك اللحين ابغى ابي ابغا زين يبي يبون وايد جذي خلني خلنا".split(),
    "levantine": "شو هلق هلأ بدي بدك بدنا هيك منيح ليش كيفك كيفكم هلا شوي ازا".split(),
}

# Formal Arabic where a friend would speak Egyptian.
_FORMAL = "ماذا لماذا الان حيث لكنني سوف هل اريد تريد اود".split()
_FORMAL_PHRASES = ("كيف حالك", "كيف حالكم")

_WORD = re.compile(r"[ء-ي]+")


def _norm(words: List[str]) -> frozenset[str]:
    return frozenset(w for item in words for w in normalize_text(item).split())


EGYPTIAN_WORDS = _norm(_EGYPTIAN)
FOREIGN_WORDS = {name: _norm(items) for name, items in _FOREIGN.items()}
FORMAL_WORDS = _norm(_FORMAL)


@dataclass
class DialectReport:
    egyptian: int = 0
    foreign: List[str] = field(default_factory=list)
    formal: List[str] = field(default_factory=list)
    arabic_words: int = 0

    @property
    def leaks(self) -> int:
        return len(self.foreign) + len(self.formal)

    @property
    def clean(self) -> bool:
        return self.leaks == 0


def check_dialect(text: str) -> DialectReport:
    """Count Egyptian markers and list the words that leak another dialect or formal Arabic."""
    norm = normalize_text(text or "")
    words = _WORD.findall(norm)
    report = DialectReport(arabic_words=len(words))
    foreign_all = frozenset().union(*FOREIGN_WORDS.values())
    for word in words:
        if word in EGYPTIAN_WORDS:
            report.egyptian += 1
        elif word in foreign_all:
            report.foreign.append(word)
        elif word in FORMAL_WORDS:
            report.formal.append(word)
    for phrase in _FORMAL_PHRASES:
        if normalize_text(phrase) in norm and normalize_text(phrase).split()[0] not in report.formal:
            report.formal.append(normalize_text(phrase))
    return report


def user_dialect(message: str, history: Sequence[Any] = ()) -> str:
    """"egyptian" when the person writes it (this message, else their recent ones), else "".

    Needs an Egyptian-only marker (ازاي, دلوقتي, كده, عايز...) and no more foreign
    markers than Egyptian ones, so a Gulf or Levantine speaker is never told to
    answer in Egyptian.
    """
    texts = [message or ""]
    for item in reversed(list(history or [])[-8:]):
        role = str(item.get("role") if isinstance(item, dict) else getattr(item, "role", "") or "").lower()
        if role in {"user", "human"}:
            texts.append(str((item.get("content") if isinstance(item, dict) else getattr(item, "content", "")) or ""))
    egyptian = foreign = 0
    for text in texts[:3]:
        report = check_dialect(text)
        egyptian += report.egyptian
        foreign += len(report.foreign)
    return "egyptian" if egyptian >= 1 and egyptian > foreign else ""


EGYPTIAN_NOTE = (
    "[The person writes Egyptian Arabic. Answer in natural Egyptian colloquial, the way a friend from Cairo texts: "
    "ازاي، ايه، دلوقتي، عشان، كده، مش، عايز، اوي، حاجة، فعلا. "
    "Never use Gulf or Levantine words (ايش، شو، بدي، هلق، هيك، خلني، ابغى) and no stiff formal Arabic "
    "(كيف حالك، ماذا، لماذا، هل). Talk about yourself without gendered words (say فاهمك, not أنا فاهم), "
    "and do not assume their gender. Short and natural, like: 'ده تقيل فعلا. حصل ايه بالظبط؟']"
)


def dialect_note(message: str, history: Sequence[Any] = ()) -> str:
    return EGYPTIAN_NOTE if user_dialect(message, history) == "egyptian" else ""


_ARABIC_LETTER = re.compile(r"[؀-ۿ]")
_LATIN_LETTER = re.compile(r"[A-Za-z]")


def is_arabic_text(text: str) -> bool:
    """More Arabic letters than Latin ones."""
    return len(_ARABIC_LETTER.findall(text or "")) > len(_LATIN_LETTER.findall(text or ""))
