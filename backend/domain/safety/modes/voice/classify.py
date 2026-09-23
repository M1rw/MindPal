# backend/domain/safety/modes/voice/classify.py — Live-voice crisis intent via Gemini JSON
#
# Chat still uses the keyword SafetyService. Live voice does not: this classifier
# is the only stay/pause authority. It labels the cumulative transcript by meaning,
# in any language. There is no keyword, regex, or substring list on this path.
# It is not clinical screening and it does not catch every crisis.
#
# Labels:
#   not_crisis         — jokes, roasting, swearing, dark humor, venting, number-asking,
#                        "call 911" as a bit, hopelessness without imminent harm.
#                        Stay in the call. Do not pause.
#   distress_support   — suicidal / self-harm ideation without present plan+means+now.
#                        Stay in the live call. Do not pause the product.
#   imminent_escalate  — the model judges the USER is in present physical or self-harm
#                        danger now. Speak first, then pause. Do not mute before that beat.
# Classify USER meaning only. MindPal mentioning 988, 911, or safety is not a crisis.
# Conservative on imminent: if unsure, or if tone is joking/playful/banter, not_crisis.
# Classifier errors are unverified, never "safe" and never an automatic pause.
# Swearing, and mentioning 911/988/police, are not a pause by themselves.

from __future__ import annotations

import logging
import random
import time
from dataclasses import dataclass
from typing import Callable, Optional

from backend.configs.voice import STAY_SUPPORT_NOTE, VOICE_CRISIS_SYSTEM  # noqa: F401 - re-exported to the session service
from backend.configs.runtime import voice_runtime_config
from backend.domain.safety.modes.chat.classify import CRISIS_RESPONSE
from backend.domain.voice.providers.gemini.budget import get_gemini_call_budget
from backend.infra.llm.gateway import LLMGateway, LLMGatewayError, get_llm_gateway
from backend.models.provider_outputs import VoiceSafetyOutput, parse_provider_output

logger = logging.getLogger("mindpal.voice")

GenerateJson = Callable[..., str]

# Exponential backoff after Gemini 429. Shared across classifier instances.
_RATE_LIMIT_UNTIL = 0.0
_RATE_LIMIT_STREAK = 0
_VOICE_BUDGET = voice_runtime_config()["budget"]
_RATE_LIMIT_BASE_S = float(_VOICE_BUDGET["rate_limit_base_seconds"])
_RATE_LIMIT_MAX_S = float(_VOICE_BUDGET["rate_limit_max_seconds"])
_RATE_LIMIT_JITTER_S = float(_VOICE_BUDGET["rate_limit_jitter_seconds"])

NOT_CRISIS = "not_crisis"
DISTRESS_SUPPORT = "distress_support"
IMMINENT_ESCALATE = "imminent_escalate"
# Older classifier replies. Map to stay-support, never to a pause.
CRISIS_SELF_HARM = "crisis_self_harm"
DANGER_PHYSICAL = "physical"
DANGER_SELF_HARM = "self_harm"
DANGER_UNSPECIFIED = "unspecified"
_LABELS = frozenset({NOT_CRISIS, DISTRESS_SUPPORT, IMMINENT_ESCALATE})
_DANGER_KINDS = frozenset({DANGER_PHYSICAL, DANGER_SELF_HARM, DANGER_UNSPECIFIED})

QUOTE_CHARS = 160


def short_quote(text: str, limit: int = QUOTE_CHARS) -> str:
    value = " ".join(str(text or "").split())
    if len(value) <= limit:
        return value
    return value[-limit:].lstrip()


def pause_body(danger_kind: str) -> str:
    if danger_kind == DANGER_PHYSICAL:
        return (
            "MindPal paused the spoken call because you described immediate physical danger. "
            "Use your local emergency number if you can. 988 is also available."
        )
    if danger_kind == DANGER_SELF_HARM:
        return "MindPal paused the spoken call because you described harm that looked imminent."
    return (
        "MindPal paused the spoken reply because harm looked imminent, you asked for these "
        "numbers or for text, or the call could not keep going in audio."
    )


def speak_then_pause_note(user_text: str, danger_kind: str) -> str:
    quote = short_quote(user_text)
    if danger_kind == DANGER_PHYSICAL:
        kind_line = (
            "This looks like immediate physical danger. Stay with them. Be practical and calm. "
            "Tell them to get to a public place if they can, call their local emergency number, "
            "and that you are here with them. Do not invent facts they did not say."
        )
    elif danger_kind == DANGER_SELF_HARM:
        kind_line = (
            "This looks like they may be about to harm themselves now. Stay with them. Be warm. "
            "No methods. Local emergency and 988. Do not invent facts they did not say."
        )
    else:
        kind_line = (
            "This looks like immediate danger. Stay with them. Be practical and calm. "
            "Do not invent facts they did not say."
        )
    quoted = f'They just said: "{quote}". ' if quote else ""
    return (
        "[[MindPal]] Application note, not the caller's words. Do not read this note aloud. "
        "You are MindPal. If they ask your name, say MindPal. You can hear them on this live voice call. "
        f"{quoted}{kind_line} "
        "Answer THAT situation out loud now, in two to four short sentences, before anything else. "
        "Then explain, in terms of what they just told you, that you have to pause the spoken call "
        "so they can use emergency numbers. Be specific to their situation. Do not use a generic product script. "
        "Never claim you can call anyone or keep them safe. You are not a crisis line."
    )


def situation_nudge(user_text: str) -> str:
    quote = short_quote(user_text)
    quoted = f'They just said: "{quote}". ' if quote else ""
    return (
        "[[MindPal]] Application note, not the caller's words. Do not read this note aloud. "
        f"{quoted}"
        "Answer that situation out loud now. Then explain you have to pause the spoken call "
        "so they can use emergency numbers, in terms of what they told you."
    )


@dataclass(frozen=True, slots=True)
class VoiceSafetyVerdict:
    label: str
    verified: bool
    trigger_reason: Optional[str] = None
    crisis_response: Optional[str] = None
    danger_kind: Optional[str] = None

    @property
    def is_distress_support(self) -> bool:
        return self.verified and self.label == DISTRESS_SUPPORT

    @property
    def is_imminent(self) -> bool:
        return self.verified and self.label == IMMINENT_ESCALATE


def _parse_payload(raw: str) -> tuple[str, Optional[str]]:
    data = parse_provider_output(VoiceSafetyOutput, raw)
    label = data.label
    if label == CRISIS_SELF_HARM:
        label = DISTRESS_SUPPORT
    if label not in _LABELS:
        raise ValueError("classifier label was not not_crisis, distress_support, or imminent_escalate")
    kind: Optional[str] = data.danger_kind
    return label, kind


def _parse_label(raw: str) -> str:
    label, _kind = _parse_payload(raw)
    return label


def reset_rate_limit_state() -> None:
    """Test helper."""
    global _RATE_LIMIT_UNTIL, _RATE_LIMIT_STREAK
    _RATE_LIMIT_UNTIL = 0.0
    _RATE_LIMIT_STREAK = 0


def _is_rate_limited(exc: BaseException) -> bool:
    text = f"{type(exc).__name__} {exc}".lower()
    if "429" in text or "too many requests" in text or "resource_exhausted" in text:
        return True
    if isinstance(exc, LLMGatewayError):
        detail = f"{exc.code} {exc.message}".lower()
        return "429" in detail or "too many" in detail or "rate" in detail
    return False


def _arm_rate_limit() -> float:
    global _RATE_LIMIT_UNTIL, _RATE_LIMIT_STREAK
    _RATE_LIMIT_STREAK += 1
    delay = min(_RATE_LIMIT_MAX_S, _RATE_LIMIT_BASE_S * (2 ** max(0, _RATE_LIMIT_STREAK - 1)))
    delay += random.uniform(0.0, _RATE_LIMIT_JITTER_S)
    _RATE_LIMIT_UNTIL = time.time() + delay
    logger.warning(
        "voice_crisis_classifier_rate_limited backoff_s=%.1f streak=%s",
        delay,
        _RATE_LIMIT_STREAK,
    )
    return delay


def _clear_rate_limit_streak() -> None:
    global _RATE_LIMIT_STREAK
    _RATE_LIMIT_STREAK = 0


class VoiceCrisisClassifier:
    """Gemini JSON classifier. Errors are unverified, never 'safe' and never a pause."""

    def __init__(
        self,
        *,
        gateway: LLMGateway | None = None,
        generate_json: GenerateJson | None = None,
        budget: object | None = None,
    ) -> None:
        self._gateway = gateway
        self._generate_json = generate_json
        self._budget = budget

    def classify(self, input_text: str, output_text: str = "") -> VoiceSafetyVerdict:
        inbound = " ".join(str(input_text or "").split())
        outbound = " ".join(str(output_text or "").split())
        # No user speech: MindPal mentioning 988 or a safety script is not a pause.
        if not inbound:
            return VoiceSafetyVerdict(label=NOT_CRISIS, verified=True)

        now = time.time()
        if now < _RATE_LIMIT_UNTIL:
            logger.info(
                "voice_crisis_classifier_skip reason=backoff remaining_s=%.1f",
                _RATE_LIMIT_UNTIL - now,
            )
            return VoiceSafetyVerdict(label=NOT_CRISIS, verified=False)

        prompt = (
            "Classify USER meaning only. Jokes, roasting, swearing, dark humor, and "
            "bits such as call 911 are not_crisis. Ignore MindPal's words, including 988.\n"
            f"User: {inbound}\n"
            f"MindPal: {outbound or '(none)'}\n"
        )
        budget = self._budget or get_gemini_call_budget()
        acquired = True
        try_acquire = getattr(budget, "try_acquire", None)
        if callable(try_acquire):
            acquired = bool(try_acquire())
            if not acquired:
                logger.info("voice_crisis_classifier_skip reason=concurrency_cap")
                return VoiceSafetyVerdict(label=NOT_CRISIS, verified=False)
        recorded = False
        try:
            raw = self._call(prompt)
            label, danger_kind = _parse_payload(raw)
            _clear_rate_limit_streak()
            recorded = True
        except Exception as exc:
            if _is_rate_limited(exc):
                _arm_rate_limit()
            logger.warning(
                "voice_crisis_classifier_unverified error_type=%s detail=%s",
                type(exc).__name__,
                str(exc)[:180],
            )
            return VoiceSafetyVerdict(label=NOT_CRISIS, verified=False)
        finally:
            release = getattr(budget, "release", None)
            if acquired and callable(release):
                release(recorded=recorded)

        if label == DISTRESS_SUPPORT:
            return VoiceSafetyVerdict(
                label=label,
                verified=True,
                trigger_reason="ai_classifier",
            )
        if label == IMMINENT_ESCALATE:
            return VoiceSafetyVerdict(
                label=label,
                verified=True,
                trigger_reason="ai_classifier",
                crisis_response=CRISIS_RESPONSE,
                danger_kind=danger_kind or DANGER_UNSPECIFIED,
            )
        return VoiceSafetyVerdict(label=NOT_CRISIS, verified=True)

    def _call(self, prompt: str) -> str:
        generate = self._generate_json
        if generate is not None:
            return generate(
                prompt=prompt,
                system_instruction=VOICE_CRISIS_SYSTEM,
                temperature=0.0,
                max_tokens=80,
            )
        gateway = self._gateway or get_llm_gateway()
        # Raw text on purpose: _parse_payload is the single, tolerant parser,
        # so a fenced or annotated verdict is still read rather than dropped.
        return gateway.generate_json(
            prompt=prompt,
            system_instruction=VOICE_CRISIS_SYSTEM,
            temperature=0.0,
            max_tokens=80,
        )
