# backend/domain/voice/reaction.py — What MindPal's face shows while the caller talks

"""Pick a listening reaction for the orb face from what the caller just said.

The live model only acts on its own turn, so the face reacts through a separate,
fast classifier: a phrase in any language goes in, one label comes out. Timing is
decided in the browser from the caller's voice; this only says what the phrase
means to a friend who is listening. It never speaks and never affects the call.
Failures and rate limits answer "none", which leaves the face on its plain nod.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from typing import Callable, Dict, Optional

from backend.infra.llm.gateway import get_llm_gateway

logger = logging.getLogger(__name__)

REACTIONS = ("smile", "laugh", "surprise", "concern", "tender", "excited", "curious", "none")
MAX_TEXT_CHARS = 240
MAX_CONTEXT_CHARS = 300
# One phrase every ~1.5s is the most a caller produces; this leaves headroom
# without letting a stuck client spend the classifier budget.
MIN_INTERVAL_S = 0.6
# MindPal's own sentences arrive in a burst while it streams; the client sends
# them one at a time, so they only need a light guard.
MIN_INTERVAL_SPEAKING_S = 0.15
MAX_PER_MINUTE = 60

REACTION_SYSTEM = (
    "You are the face of a warm friend listening on a voice call. The caller is still "
    "talking. Given the phrase they just said (any language, possibly mis-transcribed) "
    "and a little earlier context, pick the one facial reaction a caring friend would "
    "show right now, without interrupting.\n"
    "- smile: good news, pride, relief, affection.\n"
    "- laugh: something genuinely funny, a joke, playful teasing.\n"
    "- surprise: a twist, something unexpected or remarkable.\n"
    "- concern: something painful, scary, stressful, or a loss.\n"
    "- tender: something vulnerable or sad shared quietly; a moment for gentleness.\n"
    "- excited: big news, energy, something they are thrilled about.\n"
    "- curious: they asked something, or trailed off into something intriguing.\n"
    "- none: ordinary narration; a plain nod is enough.\n"
    "Judge meaning, not keywords: sarcasm, negation and tone matter "
    '("not great at all" is concern). Prefer none when unsure.\n'
    'Reply with JSON only: {"reaction": "smile|laugh|surprise|concern|tender|excited|curious|none"}'
)

SPEAKING_SYSTEM = (
    "You are the face of MindPal, a warm friend, while MindPal itself is speaking on "
    "a voice call. Given the sentence MindPal is saying right now (any language), pick "
    "the one facial expression that matches its tone, so the face and voice agree.\n"
    "- smile: warmth, delight, congratulations, reassurance.\n"
    "- laugh: laughing, joking, playful teasing (\"haha\", banter).\n"
    '- surprise: amazement or disbelief ("wait, really?", "no way").\n'
    "- concern: worry about something painful or risky.\n"
    "- tender: gentle comfort, empathy, softness with something sad.\n"
    "- excited: enthusiasm, cheering them on, big energy.\n"
    "- curious: asking a genuine question or wondering aloud.\n"
    "- none: plain, neutral talk.\n"
    "Judge the tone of the whole sentence, not single words. Prefer none when unsure.\n"
    'Reply with JSON only: {"reaction": "smile|laugh|surprise|concern|tender|excited|curious|none"}'
)

GenerateJson = Callable[..., str]


def _parse(raw: str) -> str:
    text = (raw or "").strip()
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        return "none"
    try:
        value = json.loads(text[start : end + 1]).get("reaction", "")
    except (ValueError, AttributeError):
        return "none"
    label = str(value).strip().lower()
    return label if label in REACTIONS else "none"


class VoiceReactionService:
    def __init__(self, *, generate_json: Optional[GenerateJson] = None, clock: Callable[[], float] = time.monotonic):
        self._generate_json = generate_json
        self._clock = clock
        self._lock = threading.Lock()
        self._recent: Dict[str, list[float]] = {}

    def classify(self, *, user_id_hash: str, text: str, context: str = "", speaker: str = "caller") -> str:
        """`speaker="mindpal"`: the face matching MindPal's own sentence, not a listener's reaction."""
        phrase = " ".join((text or "").split())[-MAX_TEXT_CHARS:]
        gap = MIN_INTERVAL_SPEAKING_S if speaker == "mindpal" else MIN_INTERVAL_S
        if not phrase or not self._admit(f"{user_id_hash}:{speaker}", gap):
            return "none"
        earlier = " ".join((context or "").split())[-MAX_CONTEXT_CHARS:]
        own = speaker == "mindpal"
        if own:
            prompt = f"MindPal is saying: {phrase}"
        else:
            prompt = f"Earlier: {earlier or '(start of turn)'}\nJust said: {phrase}"
        try:
            raw = self._generate()(
                prompt=prompt,
                system_instruction=SPEAKING_SYSTEM if own else REACTION_SYSTEM,
                temperature=0.0,
                max_tokens=24,
            )
        except Exception as exc:  # noqa: BLE001 - the face falls back to a nod
            logger.info("voice_reaction_unavailable error=%s", type(exc).__name__)
            return "none"
        return _parse(raw)

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
            return True
