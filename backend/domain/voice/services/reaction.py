# backend/domain/voice/reaction.py — What MindPal's face shows while the caller talks

"""Pick a listening reaction for the orb face from what the caller just said.

The live model only acts on its own turn, so the face reacts through a separate,
fast classifier: a phrase in any language goes in, one label comes out. Timing is
decided in the browser from the caller's voice; this only says what the phrase
means to a friend who is listening. It never speaks and never affects the call.
Failures and rate limits answer "none", which leaves the face on its plain nod.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable, Dict, Optional

from backend.configs.prompts import REACTION_SYSTEM, SPEAKING_SYSTEM
from backend.configs.runtime import voice_runtime_config
from backend.models.provider_outputs import VoiceReactionOutput, parse_provider_output
from backend.infra.llm.gateway import get_llm_gateway

logger = logging.getLogger(__name__)

REACTIONS = ("smile", "laugh", "surprise", "concern", "tender", "excited", "curious", "none")
_REACTION_CONFIG = voice_runtime_config()["reaction"]
MAX_TEXT_CHARS = int(_REACTION_CONFIG["max_text_chars"])
MAX_CONTEXT_CHARS = int(_REACTION_CONFIG["max_context_chars"])
# One phrase every ~1.5s is the most a caller produces; this leaves headroom
# without letting a stuck client spend the classifier budget.
MIN_INTERVAL_S = float(_REACTION_CONFIG["min_interval_seconds"])
# MindPal's own sentences arrive in a burst while it streams; the client sends
# them one at a time, so they only need a light guard.
MIN_INTERVAL_SPEAKING_S = float(_REACTION_CONFIG["min_interval_speaking_seconds"])
MAX_PER_MINUTE = int(_REACTION_CONFIG["max_per_minute"])


GenerateJson = Callable[..., str]


def _parse(raw: str) -> str:
    try:
        value = parse_provider_output(VoiceReactionOutput, raw).reaction
    except ValueError:
        return "none"
    return value if value in REACTIONS else "none"


def _reaction_policy() -> Dict[str, Any]:
    try:
        from backend.domain.dynamic.policy import policy

        return policy("voice_reaction")
    except Exception:
        return {"enabled": True, "interval_scale": 1.0}


class VoiceReactionService:
    def __init__(self, *, generate_json: Optional[GenerateJson] = None, clock: Callable[[], float] = time.monotonic):
        self._generate_json = generate_json
        self._clock = clock
        self._lock = threading.Lock()
        self._recent: Dict[str, list[float]] = {}

    def classify(self, *, user_id_hash: str, text: str, context: str = "", speaker: str = "caller") -> str:
        """`speaker="mindpal"`: the face matching MindPal's own sentence, not a listener's reaction."""
        phrase = " ".join((text or "").split())[-MAX_TEXT_CHARS:]
        # Face reactions are cosmetic LLM calls: under load they slow down, and
        # at critical they stop (the face still nods from voice timing alone).
        load_policy = _reaction_policy()
        if not load_policy["enabled"]:
            return "none"
        gap = (MIN_INTERVAL_SPEAKING_S if speaker == "mindpal" else MIN_INTERVAL_S) * float(load_policy["interval_scale"])
        if not phrase or not self._admit(f"{user_id_hash}:{speaker}", gap):
            return "none"
        earlier = " ".join((context or "").split())[-MAX_CONTEXT_CHARS:]
        own = speaker == "mindpal"
        if own:
            prompt = f"MindPal is saying: {phrase}"
        else:
            prompt = f"Earlier: {earlier or '(start of turn)'}\nJust said: {phrase}"
        try:
            if self._generate_json is not None:
                raw = self._generate_json(
                    prompt=prompt,
                    system_instruction=SPEAKING_SYSTEM if own else REACTION_SYSTEM,
                    temperature=0.0,
                    max_tokens=24,
                )
                return _parse(raw)
            output = get_llm_gateway().generate_structured(
                contract=VoiceReactionOutput,
                prompt=prompt,
                system_instruction=SPEAKING_SYSTEM if own else REACTION_SYSTEM,
                temperature=0.0,
                max_tokens=24,
            )
            return output.reaction
        except Exception as exc:  # noqa: BLE001 - the face falls back to a nod
            logger.info("voice_reaction_unavailable error=%s", type(exc).__name__)
            return "none"

    def _generate(self) -> GenerateJson:
        if self._generate_json is not None:
            return self._generate_json
        return get_llm_gateway().generate_json

    def _admit(self, user_id_hash: str, min_interval_s: float = MIN_INTERVAL_S) -> bool:
        now = self._clock()
        with self._lock:
            stamps = [t for t in self._recent.get(user_id_hash, []) if now - t < 60.0]
            if stamps and now - stamps[-1] < min_interval_s:
                return False
            if len(stamps) >= MAX_PER_MINUTE:
                return False
            stamps.append(now)
            self._recent[user_id_hash] = stamps
            # One key per account and speaker, kept forever, grew without bound.
            if len(self._recent) > 10_000:
                self._recent = {k: v for k, v in self._recent.items() if v and now - v[-1] < 60.0}
            return True
