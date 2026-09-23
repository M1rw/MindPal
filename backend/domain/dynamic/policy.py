"""Load-aware policy: one place that decides how eager non-essential work is.

The platform pulse is turned into a pressure score (0 = idle, 1 = at the soft
capacity of the busiest signal) and a level: calm, busy, strained, critical.
Each level maps to a policy in `configs/json/dynamic.json`.

What adapts:
  * memory consolidation (how many turns or facts before an AI digest or
    summary, per-user cooldowns and daily AI budgets, whether it runs inline or
    waits for the scheduler, batch size),
  * the live-voice face reaction classifier (interval, or off),
  * how much chat history goes to the model,
  * anonymous (guest) chat quotas, so signed-in people keep capacity.

What never adapts: crisis detection, crisis resources, the voice safety
classifier and its lease, and signed-in users' quotas. Safety is not a load
knob.

`MINDPAL_PRESSURE_OVERRIDE` (calm|busy|strained|critical) pins the level for
incident response or tests.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Dict, Optional

from backend.configs.runtime import dynamic_config
from backend.infra.observability.pulse import PulseSnapshot, platform_pulse

LEVELS = ("calm", "busy", "strained", "critical")


@dataclass(frozen=True)
class LoadState:
    level: str
    pressure: float
    drivers: Dict[str, float]
    pulse: Optional[PulseSnapshot]
    overridden: bool = False

    def policy(self, area: str) -> Dict[str, Any]:
        return dict(dynamic_config()["policies"][self.level][area])

    def as_dict(self) -> Dict[str, Any]:
        return {
            "level": self.level,
            "pressure": self.pressure,
            "drivers": self.drivers,
            "overridden": self.overridden,
            "pulse": self.pulse.as_dict() if self.pulse else None,
        }


def pressure_from(pulse: PulseSnapshot) -> tuple[float, Dict[str, float]]:
    capacity = dynamic_config()["capacity"]
    drivers = {
        "active_users": pulse.active_users / float(capacity["active_users_soft"]),
        "llm_calls": pulse.llm_calls_per_minute / float(capacity["llm_calls_per_minute_soft"]),
        "llm_errors": pulse.llm_error_ratio / float(capacity["llm_error_ratio_hard"]),
        "llm_rate_limits": pulse.llm_rate_limited_ratio / float(capacity["llm_rate_limited_ratio_hard"]),
        "llm_latency": pulse.llm_latency_ms / float(capacity["llm_latency_ms_soft"]),
    }
    drivers = {name: round(min(value, 2.0), 3) for name, value in drivers.items()}
    return max(drivers.values(), default=0.0), drivers


def level_for(pressure: float) -> str:
    for level in dynamic_config()["levels"]:
        if pressure < float(level["below"]):
            return str(level["name"])
    return "critical"


def current_load() -> LoadState:
    override = os.environ.get("MINDPAL_PRESSURE_OVERRIDE", "").strip().lower()
    if override in LEVELS:
        return LoadState(level=override, pressure=float(LEVELS.index(override)) / 3, drivers={}, pulse=None, overridden=True)
    try:
        pulse = platform_pulse().snapshot()
    except Exception:
        return LoadState(level="calm", pressure=0.0, drivers={}, pulse=None)
    pressure, drivers = pressure_from(pulse)
    return LoadState(level=level_for(pressure), pressure=round(pressure, 3), drivers=drivers, pulse=pulse)


def policy(area: str) -> Dict[str, Any]:
    return current_load().policy(area)
