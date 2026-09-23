"""Where the conversation is heading, from the person's recent turns. No AI call.

The strategy selector looks at one message. People don't: someone whose
messages have been getting heavier for five turns, or who keeps circling back to
their dad, needs a different reply than their latest line alone suggests.

This reads the user turns the client already sends as history and produces:
  * a direction (heavier, lighter, steady) from distress and distortion cues,
  * recurring topics: content words the person used in 3+ separate turns,
and a short prompt note plus a bias for the strategy selector.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Dict, List, Sequence

from backend.domain.adaptation.profile import normalize_text
from backend.domain.chat.strategy import _DISTORTION, _DISTRESS

MAX_TURNS = 8
MIN_TURNS_FOR_DIRECTION = 4
RECURRING_MIN_TURNS = 3

_WORD = re.compile(r"[a-z" + chr(0x0621) + "-" + chr(0x064A) + r"']+")
_STOP = frozenset(
    """
    about after again also always because been before being could didn't doesn't don't every
    feel feeling felt from have having just know like little maybe much never nothing other
    really should something still than that their them then there these they thing things think
    this today tomorrow very want what when where which while with would yeah your you're i'm
    it's that's going got get make made want wanted need needed time times okay well even
    كان كانت هذا هذه ذلك التي الذي على الى إلى عن مع في من ما لا انا أنا انت هو هي نحن كل بس
    شي ايش وش ليش كيف يعني والله مره جدا اليوم امس بعدين عشان لان لأن حتى قد لقد كنت
    """.split()
)


@dataclass
class Trajectory:
    direction: str = "steady"  # heavier | lighter | steady
    recurring: List[str] = field(default_factory=list)
    turns_seen: int = 0

    def note(self) -> str:
        parts: List[str] = []
        if self.direction == "heavier":
            parts.append("Their recent messages have been getting heavier. Slow down and stay with them; don't rush to fix.")
        elif self.direction == "lighter":
            parts.append("They seem to be settling compared with earlier in this conversation. Follow their lead; don't reopen what has eased.")
        if self.recurring:
            quoted = ", ".join(f"'{word}'" for word in self.recurring)
            parts.append(f"They keep coming back to {quoted}. It may matter more than it seems; you can gently name that.")
        if not parts:
            return ""
        return "[Conversation trajectory: " + " ".join(parts) + "]"

    def strategy_bias(self) -> Dict[str, float]:
        if self.direction == "heavier":
            return {"Active Listen": 0.5, "Guided Coach": -0.3}
        return {}


def _weight(text: str) -> float:
    normalized = normalize_text(text)
    return len(_DISTRESS.findall(normalized)) + 1.2 * len(_DISTORTION.findall(normalized))


def user_turns(history: Sequence[object] | None, message: str) -> List[str]:
    turns: List[str] = []
    for item in history or []:
        role = str(item.get("role") if isinstance(item, dict) else getattr(item, "role", "") or "").lower()
        if role not in {"user", "human"}:
            continue
        content = item.get("content") or item.get("text") if isinstance(item, dict) else getattr(item, "content", "")
        if str(content or "").strip():
            turns.append(str(content))
    if message.strip():
        turns.append(message)
    return turns[-MAX_TURNS:]


def analyze(history: Sequence[object] | None, message: str) -> Trajectory:
    turns = user_turns(history, message)
    trajectory = Trajectory(turns_seen=len(turns))
    if len(turns) >= MIN_TURNS_FOR_DIRECTION:
        weights = [_weight(turn) for turn in turns]
        half = len(weights) // 2
        earlier = sum(weights[:half]) / half
        recent = sum(weights[half:]) / (len(weights) - half)
        if recent - earlier >= 0.75 and recent >= 1:
            trajectory.direction = "heavier"
        elif earlier - recent >= 0.75 and earlier >= 1:
            trajectory.direction = "lighter"

    presence: Counter[str] = Counter()
    for turn in turns:
        words = {w.strip("'") for w in _WORD.findall(normalize_text(turn))}
        presence.update(w for w in words if len(w) >= 3 and w not in _STOP and not w.isdigit())
    trajectory.recurring = [word for word, count in presence.most_common(2) if count >= RECURRING_MIN_TURNS]
    return trajectory
