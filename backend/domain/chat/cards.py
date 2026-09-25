"""Interactive tools MindPal can put in the conversation: a card under a reply.

A breathing exercise when someone is panicking, a 5-4-3-2-1 grounding when
everything is too much, a thought record when a harsh all-or-nothing thought
has hold of them, a mood check when the conversation has been getting heavier.

Chosen here by a small deterministic policy, not by the model: chat runs on
several providers and not all of them call tools. Conservative on purpose:
  * never while MindPal is holding someone in crisis (the Safety Shield path
    returns before this is asked);
  * never two turns in a row, and not the same card twice in a short while
    (the client says which cards it showed recently);
  * an explicit ask ("help me breathe", "تمرين تنفس") always gets its card.

Finishing a card sends what they chose back as their next message, so it
flows into the reply, memory and the wellness timeline like anything they say.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from typing import Any, Dict, Optional, Sequence

KINDS = ("breathing", "grounding", "thought_record", "mood_check")

# How the reply introduces each card (the model sees it; the card does the rest).
_NOTE = {
    "breathing": "a short guided breathing exercise",
    "grounding": "a 5-4-3-2-1 grounding exercise",
    "thought_record": "a thought record (the thought, the evidence for and against it, and a kinder, truer way to see it)",
    "mood_check": "a quick mood check-in",
}

_ASK = {
    "breathing": re.compile(
        r"\b(?:breathing exercise|help me breathe|breathe with me|calm me down)\b|تمرين (?:ال)?تنفس|ساعدني (?:ا|أ)تنفس|خلني (?:ا|أ)هدى",
        re.IGNORECASE,
    ),
    "grounding": re.compile(r"\b(?:ground me|grounding exercise|5[- ]4[- ]3[- ]2[- ]1)\b|تمرين (?:ال)?تأريض", re.IGNORECASE),
    "thought_record": re.compile(r"\b(?:thought record|challenge (?:this|my) thought)\b|سجل (?:ال)?أفكار", re.IGNORECASE),
    "mood_check": re.compile(r"\b(?:mood check|check in on my mood)\b", re.IGNORECASE),
}

_CUE = {
    "breathing": re.compile(
        r"\b(?:panic\w*|can'?t breathe|hyperventilat\w*|heart (?:is )?(?:racing|pounding)|shaking|anxiety attack)\b"
        r"|هلع|ما (?:ا|أ)قدر (?:ا|أ)تنفس|قلبي يدق|نوبة قلق",
        re.IGNORECASE,
    ),
    "grounding": re.compile(
        r"\b(?:overwhelm\w*|spiral\w*|too much at once|everything at once|can'?t think straight|dissociat\w*|zoning out)\b"
        r"|مضغوط|كل شي فوق بعض|مشتت|ما (?:ا|أ)قدر (?:ا|أ)ركز",
        re.IGNORECASE,
    ),
}

# Recent cards the client reports: none within the last few replies, and not
# the same kind again within a longer window.
_GAP_TURNS = 3
_SAME_KIND_TURNS = 8


@dataclass(frozen=True)
class Card:
    kind: str
    id: str
    pattern: str = ""

    def as_event(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"kind": self.kind, "id": self.id}
        if self.pattern:
            out["pattern"] = self.pattern
        return out

    def prompt_note(self) -> str:
        return (
            f"An interactive card with {_NOTE[self.kind]} appears under your reply. Introduce it in one short, "
            "warm sentence in their language and let the card do the steps: do not write the steps out."
        )


def _recent(recent_cards: Sequence[str], turns: int) -> Sequence[str]:
    return [kind for kind in list(recent_cards)[:turns] if kind]


def choose_card(
    message: str,
    *,
    strategy: str,
    trajectory_direction: str = "steady",
    recent_cards: Sequence[str] = (),
    user_turns: int = 0,
    crisis: bool = False,
) -> Optional[Card]:
    """The card to show with this reply, or None.

    `recent_cards`: the card kind (or "") of each recent assistant reply, newest first.
    """
    if crisis or strategy == "Safety Shield":
        return None
    text = message or ""
    for kind, pattern in _ASK.items():
        if pattern.search(text):
            return _make(kind, text)
    if _recent(recent_cards, _GAP_TURNS):
        return None
    shown = set(_recent(recent_cards, _SAME_KIND_TURNS))

    def ok(kind: str) -> bool:
        return kind not in shown

    if ok("breathing") and _CUE["breathing"].search(text):
        return _make("breathing", text)
    if ok("grounding") and _CUE["grounding"].search(text):
        return _make("grounding", text)
    if ok("thought_record") and strategy == "Cognitive Tools" and len(text) >= 40:
        return _make("thought_record", text)
    if ok("mood_check") and trajectory_direction == "heavier" and user_turns >= 4:
        return _make("mood_check", text)
    return None


def _make(kind: str, text: str) -> Card:
    pattern = ""
    if kind == "breathing":
        # 4-7-8 winds down toward sleep; box breathing steadies a racing moment.
        pattern = "478" if re.search(r"\b(?:sleep|insomnia|can'?t sleep)\b|نوم|ما (?:ا|أ)قدر (?:ا|أ)نام", text, re.IGNORECASE) else "box"
    return Card(kind=kind, id=f"card_{uuid.uuid4().hex[:10]}", pattern=pattern)
