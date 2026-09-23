"""Per-person adaptive profile: how MindPal learns what works for someone.

This is bounded, inspectable learning, not model training. It keeps a small
document per account that is updated from signals the person actually gives:

* explicit requests ("too long", "just listen", "be direct"), weighted strongly;
* implicit style (message length, the language they write in), weighted lightly;
* reactions to the previous reply ("that helps", "you're not listening"), and
  explicit thumbs up/down, which reward or penalize the conversational strategy
  that produced that reply (a Beta-Bernoulli estimate per strategy).

Everything decays each turn, so the profile follows who the person is now
rather than who they were months ago. Guarantees:

* Crisis turns are never learned from.
* Learned style never overrides safety instructions; it is appended as a
  preference note and the safety rules stay authoritative.
* Guests get same-turn adaptation only; nothing is persisted without an account.
* The person can see the profile (GET /api/user/adaptation) and reset it
  (DELETE); it is included in account export and deletion.
"""

from __future__ import annotations

import logging
import re
import time
import unicodedata
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Dict, List, Optional, Sequence, Tuple

from backend.configs.runtime import adaptation_config
from backend.configs.settings import get_settings
from backend.infra.store.shared import StoreUnavailable

logger = logging.getLogger("mindpal.adaptation")

ADAPTIVE_COLLECTION = "adaptive_profiles"
PROFILE_VERSION = 1
STRATEGIES = ("Active Listen", "Cognitive Tools", "Guided Coach", "Thorough")

_ARABIC_LETTER = re.compile(r"[ء-ي]")
_LATIN_LETTER = re.compile(r"[A-Za-z]")
_ARABIC_DIACRITICS = re.compile(r"[ً-ْٰـ]")
_ARABIC_FOLD = str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ى": "ي", "ة": "ه", "ؤ": "و", "ئ": "ي"})


def normalize_text(text: str) -> str:
    value = unicodedata.normalize("NFKC", text or "").lower()
    value = value.replace("’", "'").replace("‘", "'")
    value = _ARABIC_DIACRITICS.sub("", value).translate(_ARABIC_FOLD)
    return " ".join(value.split())


def _phrase_regex(phrases: Sequence[str]) -> re.Pattern[str]:
    parts = sorted({re.escape(normalize_text(phrase)) for phrase in phrases if phrase.strip()}, key=len, reverse=True)
    return re.compile(r"(?<![\w])(?:" + "|".join(parts) + r")(?![\w])")


@dataclass(frozen=True)
class _Lexicon:
    preferences: Dict[str, Dict[str, re.Pattern[str]]]
    positive: re.Pattern[str]
    negative: re.Pattern[str]
    notes: Dict[str, str]
    learning: Dict[str, Any]


@lru_cache(maxsize=1)
def _lexicon() -> _Lexicon:
    config = adaptation_config()
    return _Lexicon(
        preferences={
            dimension: {option: _phrase_regex(phrases) for option, phrases in options.items()}
            for dimension, options in config["preferences"].items()
        },
        positive=_phrase_regex(config["feedback"]["positive"]),
        negative=_phrase_regex(config["feedback"]["negative"]),
        notes=dict(config["notes"]),
        learning=dict(config["learning"]),
    )


@dataclass
class TurnSignals:
    explicit: List[Tuple[str, str]] = field(default_factory=list)  # (dimension, option)
    implicit: List[Tuple[str, str]] = field(default_factory=list)
    feedback: int = 0  # +1 positive, -1 negative, 0 none


def read_signals(message: str) -> TurnSignals:
    lexicon = _lexicon()
    text = normalize_text(message)
    signals = TurnSignals()
    if not text:
        return signals
    for dimension, options in lexicon.preferences.items():
        for option, pattern in options.items():
            if pattern.search(text):
                signals.explicit.append((dimension, option))
    if lexicon.negative.search(text):
        signals.feedback = -1
    elif lexicon.positive.search(text) and "no thanks" not in text:
        signals.feedback = 1

    learning = lexicon.learning
    length = len(message.strip())
    if length <= int(learning["short_message_chars"]):
        signals.implicit.append(("length", "concise"))
    elif length >= int(learning["long_message_chars"]):
        signals.implicit.append(("length", "detailed"))
    arabic = len(_ARABIC_LETTER.findall(message))
    latin = len(_LATIN_LETTER.findall(message))
    if arabic + latin >= 8:
        signals.implicit.append(("language", "ar" if arabic > latin else "en"))
    return signals


def _note_feedback_signal(feedback: int) -> None:
    if not feedback:
        return
    try:
        from backend.infra.observability.pulse import platform_pulse

        platform_pulse().record_quality("positive_reaction" if feedback > 0 else "negative_reaction")
    except Exception:
        logger.debug("feedback_signal_record_skipped", exc_info=True)


def empty_profile(user_id_hash: str = "") -> Dict[str, Any]:
    return {
        "version": PROFILE_VERSION,
        "user_id_hash": user_id_hash,
        "turns_observed": 0,
        "preferences": {},
        "strategies": {},
        "last_turn": {},
        "updated_at": 0.0,
    }


def _normalize_profile(raw: Any, user_id_hash: str) -> Dict[str, Any]:
    profile = empty_profile(user_id_hash)
    if not isinstance(raw, dict):
        return profile
    prefs = raw.get("preferences")
    if isinstance(prefs, dict):
        profile["preferences"] = {
            str(dim): {str(opt): float(w) for opt, w in opts.items() if isinstance(w, (int, float))}
            for dim, opts in prefs.items()
            if isinstance(opts, dict)
        }
    strategies = raw.get("strategies")
    if isinstance(strategies, dict):
        profile["strategies"] = {
            str(name): {"alpha": float(stats.get("alpha", 1.0)), "beta": float(stats.get("beta", 1.0))}
            for name, stats in strategies.items()
            if isinstance(stats, dict) and name in STRATEGIES
        }
    if isinstance(raw.get("last_turn"), dict):
        profile["last_turn"] = {k: raw["last_turn"][k] for k in ("strategy", "at") if k in raw["last_turn"]}
    profile["turns_observed"] = int(raw.get("turns_observed") or 0)
    profile["updated_at"] = float(raw.get("updated_at") or 0.0)
    return profile


def _reward(profile: Dict[str, Any], strategy: str, amount: float) -> None:
    if strategy not in STRATEGIES or amount == 0:
        return
    stats = profile["strategies"].setdefault(strategy, {"alpha": 1.0, "beta": 1.0})
    if amount > 0:
        stats["alpha"] = round(stats["alpha"] + amount, 4)
    else:
        stats["beta"] = round(stats["beta"] - amount, 4)


def learn_from_message(profile: Dict[str, Any], message: str, *, now: Optional[float] = None) -> Dict[str, Any]:
    """Pure update: decay, then apply this message's signals. Safe to re-run in a transaction."""
    learning = _lexicon().learning
    updated = _normalize_profile(profile, str(profile.get("user_id_hash") or ""))
    decay = float(learning["decay_per_turn"])
    for options in updated["preferences"].values():
        for option in list(options):
            options[option] = round(options[option] * decay, 4)
            if options[option] < 0.01:
                del options[option]
    prior_decay = float(learning["strategy_prior_decay"])
    for stats in updated["strategies"].values():
        stats["alpha"] = round(1.0 + (stats["alpha"] - 1.0) * prior_decay, 4)
        stats["beta"] = round(1.0 + (stats["beta"] - 1.0) * prior_decay, 4)

    signals = read_signals(message)
    _note_feedback_signal(signals.feedback)
    for dimension, option in signals.explicit:
        bucket = updated["preferences"].setdefault(dimension, {})
        bucket[option] = round(bucket.get(option, 0.0) + float(learning["explicit_weight"]), 4)
        # An explicit request also counts against its opposite.
        for other in list(bucket):
            if other != option:
                bucket[other] = round(bucket[other] * 0.5, 4)
    for dimension, option in signals.implicit:
        bucket = updated["preferences"].setdefault(dimension, {})
        bucket[option] = round(bucket.get(option, 0.0) + float(learning["implicit_weight"]), 4)

    previous = str(updated.get("last_turn", {}).get("strategy") or "")
    if signals.feedback and previous:
        _reward(updated, previous, signals.feedback * float(learning["strategy_feedback_weight"]))

    updated["turns_observed"] = int(updated["turns_observed"]) + 1
    updated["updated_at"] = float(now if now is not None else time.time())
    return updated


def confident_preferences(profile: Dict[str, Any]) -> Dict[str, str]:
    learning = _lexicon().learning
    floor = float(learning["min_confident_weight"])
    margin = float(learning["min_confident_margin"])
    chosen: Dict[str, str] = {}
    for dimension, options in (profile.get("preferences") or {}).items():
        ranked = sorted(options.items(), key=lambda item: item[1], reverse=True)
        if not ranked or ranked[0][1] < floor:
            continue
        runner_up = ranked[1][1] if len(ranked) > 1 else 0.0
        if ranked[0][1] - runner_up >= margin:
            chosen[dimension] = ranked[0][0]
    return chosen


def strategy_bias(profile: Dict[str, Any]) -> Dict[str, float]:
    """Additive score adjustments for the strategy selector, in roughly [-0.6, 0.6]."""
    scale = float(_lexicon().learning["strategy_bias_scale"])
    bias: Dict[str, float] = {}
    for name, stats in (profile.get("strategies") or {}).items():
        alpha, beta = float(stats.get("alpha", 1.0)), float(stats.get("beta", 1.0))
        evidence = alpha + beta - 2.0
        if evidence <= 0:
            continue
        certainty = min(1.0, evidence / 6.0)
        bias[name] = round((alpha / (alpha + beta) - 0.5) * 2.0 * scale * certainty, 4)
    approach = confident_preferences(profile).get("approach")
    if approach == "listen":
        bias["Active Listen"] = bias.get("Active Listen", 0.0) + scale
        bias["Guided Coach"] = bias.get("Guided Coach", 0.0) - scale
    elif approach == "advice":
        bias["Guided Coach"] = bias.get("Guided Coach", 0.0) + scale
    return bias


def preference_note(profile: Dict[str, Any]) -> str:
    """Prompt text describing what has worked for this person. Empty when unsure."""
    lexicon = _lexicon()
    lines = [lexicon.notes[f"{dim}.{opt}"] for dim, opt in confident_preferences(profile).items() if f"{dim}.{opt}" in lexicon.notes]
    stats = profile.get("strategies") or {}
    worked = [name for name, s in stats.items() if s.get("alpha", 1) - s.get("beta", 1) >= 1.5]
    missed = [name for name, s in stats.items() if s.get("beta", 1) - s.get("alpha", 1) >= 1.5]
    if worked:
        lines.append("Approaches that have landed well with them: " + ", ".join(sorted(worked)) + ".")
    if missed:
        lines.append("Approaches that have not landed: " + ", ".join(sorted(missed)) + ". Adjust rather than repeat them.")
    if not lines:
        return ""
    note = "[Learned from this person's past conversations (style only; safety rules always take priority): " + " ".join(lines) + "]"
    return note[: int(lexicon.learning["max_note_chars"])]


def personalization_overrides(profile: Dict[str, Any]) -> Dict[str, Any]:
    """Map confident learned preferences onto the existing personalization keys.

    Only fills keys the person has not set explicitly in settings.
    """
    prefs = confident_preferences(profile)
    overrides: Dict[str, Any] = {}
    if prefs.get("length") == "concise":
        overrides["baseStyle"] = "concise"
    elif prefs.get("length") == "detailed":
        overrides["baseStyle"] = "detailed"
    if prefs.get("tone") == "direct":
        overrides["warmth"] = "direct"
    if prefs.get("lists") == "off":
        overrides["useHeadersLists"] = False
    if prefs.get("emoji") == "off":
        overrides["emojiSupport"] = False
    return overrides


_PERSONALIZATION_DEFAULTS = {"baseStyle": "balanced", "warmth": "warm", "useHeadersLists": True, "emojiSupport": True}


def merge_learned_personalization(
    personalization: Optional[Dict[str, Any]], learned: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    """Apply learned preferences only where the person has not chosen a non-default setting."""
    if not learned:
        return personalization
    merged = dict(personalization or {})
    for key, value in learned.items():
        current = merged.get(key)
        if current is None or current == _PERSONALIZATION_DEFAULTS.get(key):
            merged[key] = value
    return merged


@dataclass
class TurnAdaptation:
    profile: Dict[str, Any]
    note: str
    bias: Dict[str, float]
    persist: bool


class AdaptiveProfileService:
    def __init__(self, store: Any) -> None:
        self.store = store

    @staticmethod
    def enabled() -> bool:
        return get_settings().adaptive_learning_enabled()

    def load(self, user_id_hash: str) -> Dict[str, Any]:
        if not user_id_hash:
            return empty_profile()
        try:
            return _normalize_profile(self.store.get_document(ADAPTIVE_COLLECTION, user_id_hash), user_id_hash)
        except StoreUnavailable:
            return empty_profile(user_id_hash)

    def prepare_turn(self, user_id_hash: str, message: str, *, persist: bool) -> TurnAdaptation:
        """Compute this turn's adaptation (including preferences stated in this very message)."""
        if not self.enabled():
            return TurnAdaptation(empty_profile(user_id_hash), "", {}, False)
        base = self.load(user_id_hash) if persist else empty_profile()
        profile = learn_from_message(base, message)
        return TurnAdaptation(profile, preference_note(profile), strategy_bias(profile), persist)

    def commit_turn(self, user_id_hash: str, message: str, strategy: str) -> None:
        """Persist the learning from this turn. Best effort: never fails the reply."""
        if not self.enabled() or not user_id_hash:
            return

        def mutate(current: Any, write: Any) -> None:
            profile = learn_from_message(_normalize_profile(current, user_id_hash), message)
            profile["user_id_hash"] = user_id_hash
            profile["last_turn"] = {"strategy": strategy, "at": time.time()}
            write(profile)

        try:
            self.store.transact(ADAPTIVE_COLLECTION, user_id_hash, mutate)
        except Exception as exc:
            logger.warning("adaptive_profile_commit_skipped error=%s", type(exc).__name__)

    def rate(self, user_id_hash: str, rating: str, strategy: str = "") -> Dict[str, Any]:
        """Explicit thumbs up/down on a reply; rewards the strategy that produced it."""
        weight = float(_lexicon().learning["explicit_rating_weight"])
        try:
            from backend.infra.observability.pulse import platform_pulse

            platform_pulse().record_quality("thumbs_up" if rating == "up" else "thumbs_down")
        except Exception:
            logger.debug("rating_signal_record_skipped", exc_info=True)
        amount = weight if rating == "up" else -weight
        result: Dict[str, Any] = {}

        def mutate(current: Any, write: Any) -> None:
            profile = _normalize_profile(current, user_id_hash)
            target = strategy if strategy in STRATEGIES else str(profile.get("last_turn", {}).get("strategy") or "")
            _reward(profile, target, amount)
            profile["updated_at"] = time.time()
            result["strategy"] = target
            write(profile)

        self.store.transact(ADAPTIVE_COLLECTION, user_id_hash, mutate)
        return {"ok": True, "strategy": result.get("strategy") or None, "rating": rating}

    def describe(self, user_id_hash: str) -> Dict[str, Any]:
        """Human-readable view of what has been learned, for transparency."""
        profile = self.load(user_id_hash)
        return {
            "enabled": self.enabled(),
            "turns_observed": profile["turns_observed"],
            "preferences": confident_preferences(profile),
            "strategies": {
                name: {"score": round(stats["alpha"] / (stats["alpha"] + stats["beta"]), 3), "evidence": round(stats["alpha"] + stats["beta"] - 2, 2)}
                for name, stats in profile["strategies"].items()
            },
            "note": preference_note(profile),
            "updated_at": profile["updated_at"],
        }

    def reset(self, user_id_hash: str) -> bool:
        return bool(self.store.delete_document(ADAPTIVE_COLLECTION, user_id_hash))


__all__ = [
    "ADAPTIVE_COLLECTION",
    "AdaptiveProfileService",
    "TurnAdaptation",
    "confident_preferences",
    "learn_from_message",
    "merge_learned_personalization",
    "personalization_overrides",
    "preference_note",
    "read_signals",
    "strategy_bias",
]
