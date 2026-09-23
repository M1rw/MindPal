from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Pattern

_RULES_PATH = Path(__file__).with_name("json") / "memory_rules.json"


@lru_cache(maxsize=1)
def load_memory_rules() -> dict[str, Any]:
    with _RULES_PATH.open("r", encoding="utf-8") as rules_file:
        payload = json.load(rules_file)
    if not isinstance(payload, dict):
        raise ValueError("memory_rules.json must contain an object")
    return payload


def _pattern(value: str) -> Pattern[str]:
    return re.compile(value)


def _patterns(values: list[str]) -> tuple[Pattern[str], ...]:
    return tuple(_pattern(value) for value in values)


def memory_rule_values() -> dict[str, Any]:
    rules = load_memory_rules()
    limits = rules["limits"]
    return {
        "max_atoms_per_turn": int(limits["max_atoms_per_turn"]),
        "max_value_chars": int(limits["max_value_chars"]),
        "max_transcript_atoms": int(limits["max_transcript_atoms"]),
        "max_name_words": int(limits["max_name_words"]),
        "max_name_chars": int(limits["max_name_chars"]),
        "max_fact_words": int(limits["max_fact_words"]),
        "min_fact_chars": int(limits["min_fact_chars"]),
        "anonymous_user_ids": frozenset(str(value).lower() for value in rules["anonymous_user_ids"]),
        "bland_turn": _pattern(str(rules["bland_turn_pattern"])),
        "crisis_fragment": _pattern(str(rules["crisis_fragment_pattern"])),
        "email": _pattern(str(rules["email_pattern"])),
        "name_stop": frozenset(str(value).lower() for value in rules["name_stop_words"]),
        "preferred_name": _patterns(rules["preferred_name_patterns"]),
        "goal": _patterns(rules["goal_patterns"]),
        "person": tuple((str(item[0]), _pattern(str(item[1]))) for item in rules["person_patterns"]),
        "preference": _patterns(rules["preference_patterns"]),
        "weak_capture": frozenset(str(value).lower() for value in rules["weak_capture_words"]),
        "feeling": _pattern(str(rules["feeling_pattern"])),
        "problems": tuple(
            (str(item[0]), _pattern(str(item[1])), str(item[2]))
            for item in rules["problem_patterns"]
        ),
        "events": tuple(
            (str(item[0]), _pattern(str(item[1])), str(item[2]))
            for item in rules["event_patterns"]
        ),
        "occupation": _patterns(rules["occupation_patterns"]),
        "studies": _patterns(rules["studies_patterns"]),
        "location": _patterns(rules["location_patterns"]),
    }
