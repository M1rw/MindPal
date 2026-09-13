# backend/domain/greeting/engine.py — Smart Contextual Greeting Engine

from __future__ import annotations

from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any, List

from backend.infra.store.store import get_store


def _get_time_period(hour: int) -> str:
    if 5 <= hour < 12:
        return "morning"
    elif 12 <= hour < 17:
        return "afternoon"
    elif 17 <= hour < 22:
        return "evening"
    else:
        return "night"


def _get_return_gap_seconds(last_visit_iso: Optional[str]) -> Optional[float]:
    if not last_visit_iso:
        return None
    try:
        last = datetime.fromisoformat(last_visit_iso.replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - last).total_seconds()
    except Exception:
        return None


def _heuristic_greeting(
    display_name: Optional[str],
    hour: int,
    gap_seconds: Optional[float],
    is_new_user: bool,
) -> str:
    salutations = {
        "morning": "Good morning",
        "afternoon": "Good afternoon",
        "evening": "Good evening",
        "night": "Good evening",
    }
    salutation = salutations[_get_time_period(hour)]
    name_part = f", {display_name.strip().split()[0]}" if display_name else ""

    if is_new_user or gap_seconds is None:
        return f"{salutation}{name_part}."

    days = gap_seconds / 86400
    if gap_seconds < 7200:
        return f"Welcome back{name_part}."
    elif gap_seconds < 86400:
        return f"{salutation}{name_part}."
    elif days < 7:
        return f"Good to see you again{name_part} \u2014 it\u2019s been a few days."
    else:
        return f"It\u2019s been a while{name_part}. Glad you\u2019re back."


def _compute_specificity_score(
    gap_seconds: Optional[float],
    memory_atom_count: int,
    memory_topics: List[str],
    telemetry: Optional[Dict[str, Any]],
    system_load_ok: bool,
    is_first_visit_this_week: bool,
) -> int:
    # Hard blocks first
    sensitive = {"crisis", "trauma", "suicide", "self-harm", "abuse"}
    if any(t in sensitive for t in memory_topics):
        return -999
    if not system_load_ok:
        return -999

    score = 0

    # Return gap
    if gap_seconds and gap_seconds > 86400:
        score += 3

    # Memory depth
    if memory_atom_count >= 6:
        score += 2
    elif memory_atom_count >= 3:
        score += 1

    # Positive topics
    positive = {"goal", "habit", "growth", "progress", "achievement"}
    if any(t in positive for t in memory_topics):
        score += 2

    # Telemetry feedback loop
    if telemetry:
        if telemetry.get("last_greeting_engaged"):
            score += 2
        if telemetry.get("last_greeting_ignored"):
            score -= 2

    # First visit this week
    if is_first_visit_this_week:
        score += 1

    return score


class GreetingEngine:
    """
    Tier-1 Smart Greeting Engine.
    Generates a contextual, cached greeting based on:
    - User's real timezone (not server time)
    - Return gap since last visit
    - Memory graph depth and topic sensitivity
    - Telemetry feedback loop (did user engage with last greeting?)
    - System load (shed AI calls under high load)

    Cache key: greeting_cache:{uid}:{YYYY-MM-DD}:{period}
    Max 4 AI calls per user per day. Zero on cache hit.
    """

    def __init__(self) -> None:
        self.store = get_store()

    def get_greeting(
        self,
        user_id_hash: str,
        display_name: Optional[str],
        tz_offset_minutes: int,
        memory_summary: str = "",
        memory_atoms: Optional[List[Dict[str, Any]]] = None,
        telemetry: Optional[Dict[str, Any]] = None,
        system_load_ok: bool = True,
    ) -> Dict[str, Any]:
        memory_atoms = memory_atoms or []

        # Resolve user local time from tz_offset
        utc_now = datetime.now(timezone.utc)
        user_local = utc_now + timedelta(minutes=tz_offset_minutes)
        hour = user_local.hour
        date_str = user_local.strftime("%Y-%m-%d")
        period = _get_time_period(hour)

        # Check cache (2-layer: server store is source of truth)
        cache_key = f"{user_id_hash}:{date_str}:{period}"
        cached = self.store.get_document("greeting_cache", cache_key)
        if cached:
            return {**cached, "cached": True}

        # Read presence record for last visit
        presence = self.store.get_document("user_presence", user_id_hash) or {}
        last_visit_iso: Optional[str] = presence.get("last_visit_iso")
        is_new_user = not last_visit_iso and not memory_atoms

        gap_seconds = _get_return_gap_seconds(last_visit_iso)

        # Determine if first visit this week
        is_first_this_week = False
        if last_visit_iso:
            try:
                last_dt = datetime.fromisoformat(last_visit_iso.replace("Z", "+00:00"))
                delta_days = (utc_now - last_dt).days
                is_first_this_week = delta_days >= 7 or (
                    last_dt.isocalendar()[1] != utc_now.isocalendar()[1]
                )
            except Exception:
                pass

        # Update presence record
        self.store.set_document(
            "user_presence",
            user_id_hash,
            {**presence, "user_id_hash": user_id_hash, "last_visit_iso": utc_now.isoformat()},
        )

        # Extract atom topics
        memory_topics = [a.get("category", "").lower() for a in memory_atoms]

        # Score
        score = _compute_specificity_score(
            gap_seconds=gap_seconds,
            memory_atom_count=len(memory_atoms),
            memory_topics=memory_topics,
            telemetry=telemetry,
            system_load_ok=system_load_ok,
            is_first_visit_this_week=is_first_this_week,
        )

        # Generate greeting
        if score >= 5 and memory_summary and not is_new_user:
            tone = "contextual"
            first_sentence = memory_summary.split(".")[0].strip()
            name_part = f", {display_name.strip().split()[0]}" if display_name else ""
            greeting = (
                f"Good to have you back{name_part}. "
                f"Last time, {first_sentence.lower()}."
            )
        elif score >= 2 and not is_new_user:
            tone = "warm"
            greeting = _heuristic_greeting(display_name, hour, gap_seconds, is_new_user)
        else:
            tone = "standard"
            greeting = _heuristic_greeting(display_name, hour, gap_seconds, is_new_user)

        result: Dict[str, Any] = {
            "greeting": greeting,
            "tone": tone,
            "period": period,
            "cached": False,
        }
        self.store.set_document("greeting_cache", cache_key, result)
        return result
