"""How much model effort a turn gets.

Hard turns (distress, thought spirals, conversations getting heavier, long
stories, the Pro tier) get a larger thinking budget when the platform has room;
everything else keeps the provider's default. Under load, thinking is turned
off. The person's length preference caps the reply size.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Dict, Optional

from backend.configs.runtime import dynamic_config
from backend.domain.chat.trajectory import Trajectory
from backend.domain.dynamic.policy import LoadState

_HARD_STRATEGIES = frozenset({"Cognitive Tools", "Thorough"})


@dataclass(frozen=True)
class GenerationPlan:
    thinking_budget: Optional[int]  # None = provider default
    max_tokens: int
    depth: str  # "deep" or "standard"
    reason: str


def plan_generation(
    *,
    message: str,
    strategy: str,
    reflecting_distress: bool,
    trajectory: Trajectory,
    personalization: Optional[Dict[str, Any]],
    load: LoadState,
) -> GenerationPlan:
    config = dynamic_config()["generation"]
    policy = load.policy("generation")

    reasons = []
    if strategy in _HARD_STRATEGIES:
        reasons.append(strategy.lower().replace(" ", "_"))
    if reflecting_distress:
        reasons.append("distress")
    if trajectory.direction == "heavier":
        reasons.append("getting_heavier")
    if len(message) >= int(config["deep_min_chars"]):
        reasons.append("long_message")
    deep = bool(reasons)

    budget = int(policy["deep_thinking_budget" if deep else "standard_thinking_budget"])
    style = str((personalization or {}).get("baseStyle") or "balanced").lower()
    max_tokens = int(config["max_tokens"].get(style, config["max_tokens"]["balanced"]))
    if deep and style != "concise":
        max_tokens = max(max_tokens, int(config["max_tokens"]["balanced"]))
    return GenerationPlan(
        thinking_budget=None if budget < 0 else budget,
        max_tokens=max_tokens,
        depth="deep" if deep else "standard",
        reason=",".join(reasons) or "default",
    )


_WORDS = re.compile(r"[\w\u0600-\u06FF']+")
_ASKS_FOR_MORE = re.compile(
    r"\b(options|steps|plan|explain|how (?:do|can|should) i|what should i|ideas|tips|pros and cons|compare)\b"
    r"|خطوات|خيارات|اشرح|وش اسوي|ايش اسوي|شو اعمل",  # steps, options, explain, what do I do
    re.IGNORECASE,
)


def reply_size_note(message: str, personalization: Optional[Dict[str, Any]] = None) -> str:
    """A concrete size for this reply, from the message itself.

    Small chat models follow "reply in one or two sentences" far more reliably
    than "match the length of the message", so the gateway gets the number.
    Nothing is added for long messages or explicit requests for depth.
    """
    style = str((personalization or {}).get("baseStyle") or "balanced").lower()
    if style == "detailed" or _ASKS_FOR_MORE.search(message or ""):
        return ""
    count = len(_WORDS.findall(message or ""))
    if count <= 4:
        return "[This turn: their message is very short. Reply in one or two short sentences.]"
    if count <= 15:
        return "[This turn: a short message. Keep the reply to a few sentences, one paragraph.]"
    if count <= 60 or style == "concise":
        return "[This turn: keep the reply to one or two short paragraphs.]"
    return ""
