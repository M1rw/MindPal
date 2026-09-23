"""How much model effort a turn gets.

Hard turns (distress, thought spirals, conversations getting heavier, long
stories, the Pro tier) get a larger thinking budget when the platform has room;
everything else keeps the provider's default. Under load, thinking is turned
off. The person's length preference caps the reply size.
"""

from __future__ import annotations

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
