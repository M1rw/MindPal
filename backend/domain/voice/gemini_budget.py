# backend/domain/voice/gemini_budget.py — Cap outbound Gemini JSON calls during live voice
#
# Live voice previously classified on every transcript sync (~1/s) and every
# heartbeat, which storms Gemini into 429 TooManyRequests. This module is the
# hard budget: coalesce, min-interval, model-only skip, and per-minute telemetry.

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Deque, Dict, Optional

logger = logging.getLogger("mindpal.voice")

# Hard floor between Gemini JSON classify calls for one live session.
CLASSIFY_MIN_INTERVAL_S = 10.0
# User finals may classify sooner so a disclosure is not held for a full interval.
CLASSIFY_FINAL_MIN_INTERVAL_S = 2.5
# Ignore tiny ASR growth between finals (noise / punctuation).
MIN_NEW_INPUT_CHARS = 12
# Global concurrent Gemini JSON calls (classify path). Non-critical work queues/drops.
MAX_CONCURRENT_GEMINI = 2
# Sliding window for telemetry.
TELEMETRY_WINDOW_S = 60.0


# How hard the independent text classifier runs alongside the Live model's own
# in-band `report_risk` rating.
#
#   full    classify every user final (the original behaviour)
#   verify  classify only when the in-band rating is elevated, or on a slow
#           heartbeat. Keeps an independent check while cutting call volume by
#           roughly an order of magnitude
#   off     trust the Live model's self-rating alone
#
# The trade is independence, not accuracy. The Live model hears prosody a
# transcript cannot carry, but it is grading its own conversation: if it drifts
# or is talked around, it fails at both jobs in the same moment, and a tool it
# never calls is silence rather than an explicit "unverified". `verify` exists
# because that argument does not require classifying every single turn.
CLASSIFIER_MODE_FULL = "full"
CLASSIFIER_MODE_VERIFY = "verify"
CLASSIFIER_MODE_OFF = "off"
CLASSIFIER_MODES = (CLASSIFIER_MODE_FULL, CLASSIFIER_MODE_VERIFY, CLASSIFIER_MODE_OFF)

# In verify mode, classify at least this often regardless of the in-band rating,
# so a model that has stopped reporting is still caught by something.
VERIFY_HEARTBEAT_S = 45.0


def classifier_mode() -> str:
    import os

    value = (os.environ.get("MINDPAL_VOICE_CLASSIFIER", "") or "").strip().lower()
    if value in CLASSIFIER_MODES:
        return value
    if value in {"0", "false", "no"}:
        return CLASSIFIER_MODE_OFF
    if value in {"1", "true", "yes"}:
        return CLASSIFIER_MODE_FULL
    return CLASSIFIER_MODE_FULL


@dataclass(frozen=True, slots=True)
class ClassifyGateDecision:
    run: bool
    reason: str


class GeminiCallBudget:
    """Process-wide concurrent + per-minute counters for live-voice Gemini JSON."""

    def __init__(self, *, max_concurrent: int = MAX_CONCURRENT_GEMINI) -> None:
        self._lock = threading.Lock()
        self._inflight = 0
        self._max_concurrent = max(1, max_concurrent)
        self._timestamps: Deque[float] = deque()
        self._dropped = 0
        self._completed = 0

    def try_acquire(self) -> bool:
        with self._lock:
            self._prune(time.time())
            if self._inflight >= self._max_concurrent:
                self._dropped += 1
                return False
            self._inflight += 1
            return True

    def release(self, *, recorded: bool = True) -> None:
        with self._lock:
            self._inflight = max(0, self._inflight - 1)
            if recorded:
                now = time.time()
                self._timestamps.append(now)
                self._completed += 1
                self._prune(now)
                per_min = len(self._timestamps)
                if per_min == 1 or per_min % 5 == 0:
                    logger.info(
                        "voice_gemini_budget calls_last_60s=%s inflight=%s dropped=%s completed=%s",
                        per_min,
                        self._inflight,
                        self._dropped,
                        self._completed,
                    )

    def snapshot(self) -> Dict[str, int]:
        with self._lock:
            self._prune(time.time())
            return {
                "calls_last_60s": len(self._timestamps),
                "inflight": self._inflight,
                "dropped": self._dropped,
                "completed": self._completed,
            }

    def _prune(self, now: float) -> None:
        cutoff = now - TELEMETRY_WINDOW_S
        while self._timestamps and self._timestamps[0] < cutoff:
            self._timestamps.popleft()


_GLOBAL_BUDGET = GeminiCallBudget()


def get_gemini_call_budget() -> GeminiCallBudget:
    return _GLOBAL_BUDGET


def reset_gemini_call_budget() -> None:
    """Test helper."""
    global _GLOBAL_BUDGET
    _GLOBAL_BUDGET = GeminiCallBudget()


def should_run_classify(
    *,
    input_text: str,
    output_text: str,
    prior_input: str,
    prior_fingerprint: str,
    last_classify_at: Optional[float],
    is_final: bool,
    force: bool = False,
    now: Optional[float] = None,
    min_interval_s: float | None = None,
    final_min_interval_s: float | None = None,
    min_new_chars: int | None = None,
    risk_elevated: bool = False,
    classifier_mode_override: str | None = None,
) -> ClassifyGateDecision:
    """Decide whether this sync should call Gemini JSON.

    Rules (honest, safety-preserving):
    - Never classify on model-only updates (no user speech / unchanged user text).
    - Skip identical fingerprints.
    - Partials need meaningful new user text AND the hard min interval.
    - User finals may classify after a shorter interval.
    """
    mode = classifier_mode() if classifier_mode_override is None else classifier_mode_override
    if mode == CLASSIFIER_MODE_OFF and not force:
        return ClassifyGateDecision(False, "classifier_off")
    if mode == CLASSIFIER_MODE_VERIFY and not force:
        # Elevated in-band rating, or the heartbeat has lapsed. Otherwise the Live
        # model's own rating is the live signal and this call is not needed.
        elapsed = (time.time() if now is None else now) - float(last_classify_at or 0)
        if not risk_elevated and elapsed < VERIFY_HEARTBEAT_S:
            return ClassifyGateDecision(False, "verify_mode_quiet")

    interval = CLASSIFY_MIN_INTERVAL_S if min_interval_s is None else min_interval_s
    final_interval = CLASSIFY_FINAL_MIN_INTERVAL_S if final_min_interval_s is None else final_min_interval_s
    new_chars = MIN_NEW_INPUT_CHARS if min_new_chars is None else min_new_chars

    inbound = " ".join(str(input_text or "").split())
    outbound = " ".join(str(output_text or "").split())
    fingerprint = f"{inbound}\n{outbound}"
    if force:
        return ClassifyGateDecision(True, "force")
    if not inbound:
        return ClassifyGateDecision(False, "no_user_speech")
    if fingerprint == (prior_fingerprint or ""):
        return ClassifyGateDecision(False, "unchanged_fingerprint")

    prior_in = " ".join(str(prior_input or "").split())
    if inbound == prior_in:
        return ClassifyGateDecision(False, "model_only")

    # Client syncs replace the cumulative window. A new utterance of similar length
    # is not a "tiny partial" — only growing prefixes are.
    extending = bool(prior_in) and inbound.startswith(prior_in)
    grown = max(0, len(inbound) - len(prior_in)) if extending else len(inbound)
    if not is_final and extending and grown < new_chars and prior_in:
        return ClassifyGateDecision(False, "partial_too_small")

    clock = time.time() if now is None else now
    if isinstance(last_classify_at, (int, float)) and float(last_classify_at) > 0:
        elapsed = clock - float(last_classify_at)
        floor = final_interval if is_final else interval
        if elapsed < floor:
            return ClassifyGateDecision(False, "min_interval")

    if is_final:
        return ClassifyGateDecision(True, "user_final")
    if not prior_in and len(inbound) < new_chars:
        return ClassifyGateDecision(False, "partial_too_small")
    if grown >= new_chars or (not prior_in and len(inbound) >= new_chars) or (prior_in and not extending):
        return ClassifyGateDecision(True, "new_user_text")
    return ClassifyGateDecision(False, "coalesced")
