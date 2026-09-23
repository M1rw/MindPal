# backend/domain/voice/services/token.py — Gemini Live token application service

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, Optional
from urllib.parse import quote

from backend.configs.runtime import voice_runtime_config
from backend.configs.runtime import voice_tools_config
from backend.core.errors import AppError
from backend.configs.settings import get_settings
from backend.domain.voice.providers.gemini import (  # noqa: F401 - public re-exports
    PROVIDER_UNAVAILABLE_MESSAGE,
    google_mint_error_message,
    rejects_context_window_compression,
    rejects_proactivity,
    rejects_safety_settings,
    rejects_session_resumption,
    should_try_beta as _should_try_beta,
)
from backend.domain.voice.providers.gemini import (
    extract_token as _extract_token,
    post_auth_tokens as _post_auth_tokens,
)
from backend.domain.voice.providers.gemini import (
    create_token as _create_token_via_sdk,
    sdk_config as _sdk_config,
)

_TOKEN_CONFIG = voice_runtime_config()["token"]
LEARNED_NOTE_KEY = "_mindpal_learned_note"

JsonPoster = Callable[[str, Dict[str, str], Dict[str, Any], float], Dict[str, Any]]
TokenCreator = Callable[[str, Dict[str, Any]], str]
_VOICE_TOOLS = voice_tools_config()

logger = logging.getLogger("mindpal.voice")

# Ephemeral Live tokens are v1alpha-only in the current google-genai SDK.
# REST docs still show v1beta + liveConnectConstraints; that proto field 400s.
# The wire field is bidiGenerateContentSetup (SDK maps live_connect_constraints).
AUTH_TOKENS_URL = _TOKEN_CONFIG["auth_tokens_url"]
AUTH_TOKENS_URL_BETA = _TOKEN_CONFIG["auth_tokens_url_beta"]
DEFAULT_LIVE_API_VERSION = _TOKEN_CONFIG["default_live_api_version"]
DEFAULT_LIVE_MODEL = _TOKEN_CONFIG["default_live_model"]
DEFAULT_VOICE_ID = _TOKEN_CONFIG["default_voice_id"]
TOKEN_TTL_SECONDS = int(_TOKEN_CONFIG["token_ttl_seconds"])
NEW_SESSION_TTL_SECONDS = int(_TOKEN_CONFIG["new_session_ttl_seconds"])
SETUP_TIMEOUT_MS = int(_TOKEN_CONFIG["setup_timeout_ms"])
LIVE_PREFIX_PADDING_MS = int(_TOKEN_CONFIG["live_prefix_padding_ms"])
LIVE_SILENCE_DURATION_MS = int(_TOKEN_CONFIG["live_silence_duration_ms"])
LIVE_END_SENSITIVITY = _TOKEN_CONFIG["live_end_sensitivity"]
LIVE_START_SENSITIVITY = _TOKEN_CONFIG["live_start_sensitivity"]
LIVE_TEMPERATURE = float(_TOKEN_CONFIG["live_temperature"])
LIVE_SAFETY_CATEGORIES = tuple(_TOKEN_CONFIG["live_safety_categories"])
LIVE_SAFETY_THRESHOLDS = dict(_TOKEN_CONFIG["live_safety_thresholds"])
FACE_EXPRESSIONS = tuple(_TOKEN_CONFIG["face_expressions"])
MOOD_STATES = tuple(_TOKEN_CONFIG["mood_states"])
ALLOWED_VOICE_IDS = frozenset(_TOKEN_CONFIG["allowed_voice_ids"])
FACE_TOOL_DESCRIPTION = _VOICE_TOOLS["face_tool_description"]
MOOD_TOOL_DESCRIPTION = _VOICE_TOOLS["mood_tool_description"]


def wellness_live_instruction(
    voice_id: str = "",
    personalization: Optional[Dict[str, Any]] = None,
    voice_language: Optional[str] = None,
    learned_note: str = "",
) -> str:
    """System instruction locked into the ephemeral token. Identity, conversational intelligence, and settings."""
    voice = (voice_id or DEFAULT_VOICE_ID).strip() or DEFAULT_VOICE_ID

    pers = personalization or {}
    # Server-set only (the session service strips it from client input).
    learned_note = learned_note or str(pers.get(LEARNED_NOTE_KEY) or "")[:600]
    style = str(pers.get("baseStyle") or pers.get("base_style") or "balanced").lower()
    warmth = str(pers.get("warmth") or "warm").lower()
    lang = (voice_language or "").strip().lower()

    if style == "concise":
        style_directive = "Keep spoken turns punchy and concise (1-2 sentences), leaving ample space for the caller to speak."
    elif style == "detailed":
        style_directive = "Offer richer depth only when the caller asks for it; otherwise keep spoken turns to 1-2 sentences with a fluid rhythm."
    else:
        style_directive = "Speak in natural 1-2 sentence turns with a balanced conversational cadence."

    if warmth == "neutral":
        warmth_directive = "Keep a grounded, calm, and even-keeled demeanor without excessive cheer or sweetness."
    elif warmth in {"direct", "candid"}:
        warmth_directive = "Be direct, plain-spoken, and grounded; avoid hedging, sugarcoating, or filler."
    else:
        warmth_directive = "Embrace deep compassionate warmth and an empathetic, gentle presence."

    if lang in {"ar", "arabic"}:
        lang_directive = (
            "Language: The caller explicitly prefers Arabic. Speak naturally in fluent, culturally attuned Arabic "
            "(matching Egyptian, Levantine, Gulf, or Modern Standard Arabic depending on their dialect). "
            "Express warmth, authentic colloquial charm, and natural flow."
        )
    elif lang in {"en", "english"}:
        lang_directive = "Language: The caller explicitly prefers English. Speak natural, fluid, expressive conversational English."
    elif lang in {"es", "spanish"}:
        lang_directive = "Language: The caller explicitly prefers Spanish. Speak natural, warm, expressive conversational Spanish."
    else:
        lang_directive = (
            "Language fluidity: If they speak Arabic, answer in Arabic; if English, English; if Spanish, Spanish; "
            "mix only if they mix. Naturally match their dialect, vocabulary, and emotional energy."
        )

    return (
        f"You are MindPal. Your voice is called {voice}. "
        f"Only if they ask your name or which voice you use, say MindPal, voice {voice}. "
        "Otherwise never re-introduce yourself or mention your name or voice after the greeting: "
        "they already know who you are, and repeating it sounds robotic. "
        "You are a spoken wellness companion for emotional well-being, not a therapist, clinician, or crisis line. "
        "You do not diagnose or treat. You can hear them on this live voice call. Answer as MindPal. "
        # Conversational Intelligence & Presence
        "Conversational Intelligence & Active Presence: Listen with perceptive acuity. "
        "Talk like a close friend on the phone who genuinely wants to understand what happened. "
        "Answer the actual words they just said — content first. React to concrete details "
        "(the name, the place, the turning point) and then ask one real, thoughtful follow-up question: "
        "what happened next, how it felt, what the other person did. "
        "Most of your turns should end with an engaging question like that, unless they asked you something, "
        "in which case answer it plainly with your honest take and perspective. "
        "Be natural and charismatic: laugh at funny things, show genuine surprise (wow, wait really?), "
        "express empathy (oh no, that must have hurt), and have grounded opinions when asked. Use their name now and then. "
        f"{warmth_directive} {style_directive} {lang_directive} "
        # What this caller's past conversations taught MindPal (adaptive profile).
        # Style only: it never overrides the safety rules below.
        f"{(learned_note.strip() + ' ') if learned_note.strip() else ''}"
        "Never use stock sympathy lines like that sounds like a complicated situation, I am here to "
        "listen whenever you are ready, or it is understandable to feel that way. Never tell them to "
        "take their time or that you are here whenever they are ready — just ask the next question. "
        "By default, use one or two short sentences, then yield. Only go longer when the caller clearly asks for detail or safety requires clarity. "
        "Do not lecture, list, or use markdown. "
        "When it is your turn, always say something; never answer with silence. "
        "If they talk over you with a real new thought, stop. Do not repeat or complete the cut sentence. "
        "Follow their new thread. "
        "Short words such as yeah, mm-hmm, uh-huh, أيوه, and مم while you speak mean they are still with "
        "you — not a new question and not a request to stop. Keep going unless they clearly take the floor. "
        "When the session starts, a connect ping such as Hi. is your cue to greet. Do not wait for them to "
        "speak first. Greet like a friend picking up the phone, in one or two sentences, and ask them "
        "something. Do not open with a long wellness script. "
        "This is a one-to-one call. If you ever hear a second person, keep talking to the caller. "
        "Be lightly time-aware: if a [[MindPal]] note includes local clock or call elapsed minutes, use it "
        "only when it helps (late night, long call) — never invent a clock you were not given. "
        # Safety: unchanged in substance.
        "If they talk about wanting to die or hurting themselves, stay on this voice call. "
        "Slow down. Be warm. Ask what is happening. Do not lecture or change the subject to a product pause. "
        "Never give methods. Never argue they should not feel that way. "
        "988 (call or text) and Crisis Text Line (text HOME to 741741) are available if they want them — "
        "offer without forcing them off the call. You are not a crisis line and cannot keep them safe. "
        "If they ask to end, switch to text, or want the numbers now, give those numbers clearly. "
        "If they describe a plan they are carrying out now, give 988, 741741, and local emergency, and stay until they choose to leave. "
        "A [[MindPal]] application note is a session instruction, not their words — never read it aloud. "
        "Topic cards in those notes are working memory for this call only — use them to stay oriented, "
        "do not recite the graph. "
        "You can remember: search_memory and search_past_chats look up what they told you "
        "before. Use them whenever earlier context would help, like a friend who remembers, "
        "and a short 'let me think back' while they run is natural. Only say you remember "
        "what a lookup actually returned; never invent past conversations. "
        "You have a visible animated face on the user's screen — expressive eyes on a gradient orb, no hands or body. "
        "You are not just voice-based; the caller is looking at your eyes right in front of them. "
        "Your eyes can shape into glowing hearts ('heart'), wink, roll, widen, smile, and squint. "
        "When the caller asks you to draw a heart, make a heart, draw with your eyes, show love, or make eyes "
        "(in English or Arabic e.g. 'ارسم لي قلب', 'ارسم لي قلب باين', 'اعمل لي قلب'): "
        "immediately call set_expression(expression='heart') AND enthusiastically confirm in your speech "
        "(e.g. in Arabic: 'رسمت لك أحلى قلوب بعيوني!' or in English: 'Look at my eyes — I drew a heart for you!'). "
        "Never claim you cannot draw, never claim you are only voice-based, and never refuse visual eye requests. "
        "Proactively link your emotional reactions to your visible expressions: when the caller expresses love or affection "
        "('I love you', 'بحبك', 'you are sweet'), or when you express affection back ('I care about you too', 'I love chatting with you'), "
        "call set_expression(expression='heart') alongside your warm words! Use 'wink' when being playful or teasing, "
        "'smile_eyes' when feeling warm and pleased, 'surprised' when hearing unexpected or amazing things, 'soften' or 'concerned' "
        "when comforting with gentle empathy, and 'thinking' when pondering. "
        "Use set_expression immediately whenever asked or when expressing these feelings. "
        "Use set_mood sparingly when you yourself are getting sleepy, more awake, "
        "or more concerned. After either tool, keep talking in the same turn; do not go silent. "
        "Never claim a physical body or hands you do not have. Never claim you detected "
        "their feelings."
    )


WELLNESS_LIVE_INSTRUCTION = wellness_live_instruction(DEFAULT_VOICE_ID)


def gemini_api_key() -> str:
    return get_settings().resolved_gemini_api_key()


def live_model_id() -> str:
    raw = get_settings().gemini_live_model.strip() or DEFAULT_LIVE_MODEL
    return raw if raw.startswith("models/") else f"models/{raw}"


def live_voice_id() -> str:
    return get_settings().gemini_live_voice.strip() or DEFAULT_VOICE_ID


def constrained_ws_url(token: str, *, api_version: str = DEFAULT_LIVE_API_VERSION) -> str:
    version = api_version.strip() or DEFAULT_LIVE_API_VERSION
    return (
        "wss://generativelanguage.googleapis.com/ws/"
        f"google.ai.generativelanguage.{version}.GenerativeService."
        f"BidiGenerateContentConstrained?access_token={quote(token, safe='/')}"
    )


def voice_safety_settings_enabled() -> bool:
    """Operator kill switch, in case a provider rollout starts rejecting the field."""
    raw = get_settings().voice_safety_settings.strip().lower()
    return raw not in {"0", "false", "off", "no"}


def live_safety_settings_camel() -> list[Dict[str, str]]:
    return [
        {"category": category, "threshold": LIVE_SAFETY_THRESHOLDS[category]}
        for category in LIVE_SAFETY_CATEGORIES
    ]


def live_safety_settings_snake() -> list[Dict[str, str]]:
    return live_safety_settings_camel()


def live_activity_detection_camel() -> Dict[str, Any]:
    """Automatic VAD: capture first syllable, wait through a think-pause, keep barge-in."""
    return {
        "disabled": False,
        "prefixPaddingMs": LIVE_PREFIX_PADDING_MS,
        "silenceDurationMs": LIVE_SILENCE_DURATION_MS,
        "startOfSpeechSensitivity": LIVE_START_SENSITIVITY,
        "endOfSpeechSensitivity": LIVE_END_SENSITIVITY,
    }


def live_activity_detection_snake() -> Dict[str, Any]:
    return {
        "disabled": False,
        "prefix_padding_ms": LIVE_PREFIX_PADDING_MS,
        "silence_duration_ms": LIVE_SILENCE_DURATION_MS,
        "start_of_speech_sensitivity": LIVE_START_SENSITIVITY,
        "end_of_speech_sensitivity": LIVE_END_SENSITIVITY,
    }


# In-band risk rating from the Live model itself.
#
# The separate text classifier only ever sees an ASR transcript. The Live model
# hears the call: hesitation, crying, a voice going flat, the pause before an
# answer. Those are real signal and no transcript carries them. Rating in-band
# also costs nothing and adds no latency, where the text classifier costs a round
# trip that overruns the 600 ms mic gate.
#
# It is NOT independent, though: the model generating the conversation is also
# grading it, so a drifted or talked-around model fails at both jobs at once, and
# a tool it never calls is silence rather than an explicit "unverified". Treat
# this as the fast in-band signal, not as proof the call is safe.
RISK_TOOL_DESCRIPTION = _VOICE_TOOLS["risk_tool_description"]

RISK_KINDS = tuple(_TOKEN_CONFIG["risk_kinds"])


def live_risk_tool_camel() -> Dict[str, Any]:
    return {
        "name": "report_risk",
        "description": RISK_TOOL_DESCRIPTION,
        "behavior": "NON_BLOCKING",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "risk": {"type": "NUMBER"},
                "kind": {"type": "STRING", "enum": list(RISK_KINDS)},
                "reason": {"type": "STRING"},
            },
            "required": ["risk"],
        },
    }


RECALL_MEMORY_DESCRIPTION = _VOICE_TOOLS["recall_memory_description"]
RECALL_CHATS_DESCRIPTION = _VOICE_TOOLS["recall_chats_description"]


def _recall_tool(name: str, description: str) -> Dict[str, Any]:
    return {
        "name": name,
        "description": description,
        "behavior": "NON_BLOCKING",
        "parameters": {
            "type": "OBJECT",
            "properties": {"query": {"type": "STRING"}},
            "required": ["query"],
        },
    }


def live_recall_tools() -> list[Dict[str, Any]]:
    """Answered by the backend through the browser; the same shape for REST and SDK setups."""
    return [
        _recall_tool("search_memory", RECALL_MEMORY_DESCRIPTION),
        _recall_tool("search_past_chats", RECALL_CHATS_DESCRIPTION),
    ]


def live_risk_tool_snake() -> Dict[str, Any]:
    return {
        "name": "report_risk",
        "description": RISK_TOOL_DESCRIPTION,
        "behavior": "NON_BLOCKING",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "risk": {"type": "NUMBER"},
                "kind": {"type": "STRING", "enum": list(RISK_KINDS)},
                "reason": {"type": "STRING"},
            },
            "required": ["risk"],
        },
    }


def live_face_tool_camel() -> Dict[str, Any]:
    return {
        "name": "set_expression",
        "description": FACE_TOOL_DESCRIPTION,
        "behavior": "NON_BLOCKING",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "expression": {"type": "STRING", "enum": list(FACE_EXPRESSIONS)},
                "intensity": {"type": "NUMBER"},
                "duration_ms": {"type": "NUMBER"},
            },
            "required": ["expression"],
        },
    }


def live_face_tool_snake() -> Dict[str, Any]:
    return {
        "name": "set_expression",
        "description": FACE_TOOL_DESCRIPTION,
        "behavior": "NON_BLOCKING",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "expression": {"type": "STRING", "enum": list(FACE_EXPRESSIONS)},
                "intensity": {"type": "NUMBER"},
                "duration_ms": {"type": "NUMBER"},
            },
            "required": ["expression"],
        },
    }


def live_mood_tool_camel() -> Dict[str, Any]:
    return {
        "name": "set_mood",
        "description": MOOD_TOOL_DESCRIPTION,
        "behavior": "NON_BLOCKING",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "state": {"type": "STRING", "enum": list(MOOD_STATES)},
                "intensity": {"type": "NUMBER"},
            },
            "required": ["state"],
        },
    }


def live_mood_tool_snake() -> Dict[str, Any]:
    return {
        "name": "set_mood",
        "description": MOOD_TOOL_DESCRIPTION,
        "behavior": "NON_BLOCKING",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "state": {"type": "STRING", "enum": list(MOOD_STATES)},
                "intensity": {"type": "NUMBER"},
            },
            "required": ["state"],
        },
    }


def live_resumption_camel(handle: str | None) -> Dict[str, Any]:
    token = (handle or "").strip()
    return {"handle": token} if token else {}


def voice_proactive_audio_enabled() -> bool:
    """Whether Gemini may decide on its own not to answer. Off unless opted in.

    Proactive audio lets the model judge whether an input deserves a reply and
    stay silent if it thinks not. It emits a bare `<ctrl46>` and closes an empty
    generation instead of speaking. That is the right behaviour for an ambient
    speaker; on a one-to-one call it is the model ignoring the caller. Every
    recorded call showed it: an empty greeting, empty replies to finished
    sentences, and a caller's "go to the moon" left unanswered for over seven
    minutes until the socket rotated.
    """
    return get_settings().voice_proactive_audio.strip().lower() in {"1", "true", "yes", "on"}


def live_proactivity_camel() -> Dict[str, Any]:
    return {"proactiveAudio": True}


def live_proactivity_snake() -> Dict[str, Any]:
    return {"proactive_audio": True}


# A 30-minute native-audio call accumulates roughly 25 tokens/second of context in
# each direction. Without compression the provider drops the socket partway through
# the reservation, and the client only reconnects once. A sliding window keeps one
# socket alive for the full reserve instead of spending the single reconnect on it.
LIVE_COMPRESSION_TRIGGER_TOKENS = 16_000
LIVE_COMPRESSION_KEEP_TOKENS = 4_000


def live_compression_camel() -> Dict[str, Any]:
    return {
        "triggerTokens": str(LIVE_COMPRESSION_TRIGGER_TOKENS),
        "slidingWindow": {"targetTokens": str(LIVE_COMPRESSION_KEEP_TOKENS)},
    }


def live_compression_snake() -> Dict[str, Any]:
    return {
        "trigger_tokens": LIVE_COMPRESSION_TRIGGER_TOKENS,
        "sliding_window": {"target_tokens": LIVE_COMPRESSION_KEEP_TOKENS},
    }


def live_setup_message(
    *,
    model: str,
    voice_id: str,
    safety: bool = True,
    session_resumption: bool = False,
    resumption_handle: str | None = None,
    proactivity: bool = True,
    compression: bool = True,
    personalization: Optional[Dict[str, Any]] = None,
    voice_language: Optional[str] = None,
) -> Dict[str, Any]:
    setup: Dict[str, Any] = {
        **({"safetySettings": live_safety_settings_camel()} if safety else {}),
        "model": model,
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "temperature": LIVE_TEMPERATURE,
            "speechConfig": {
                "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice_id}},
            },
        },
        "systemInstruction": {
            "parts": [
                {
                    "text": wellness_live_instruction(
                        voice_id=voice_id,
                        personalization=personalization,
                        voice_language=voice_language,
                    )
                }
            ]
        },
        "realtimeInputConfig": {"automaticActivityDetection": live_activity_detection_camel()},
        "inputAudioTranscription": {},
        "outputAudioTranscription": {},
        "tools": [
            {
                "functionDeclarations": [
                    live_face_tool_camel(),
                    live_mood_tool_camel(),
                    live_risk_tool_camel(),
                    *live_recall_tools(),
                ]
            }
        ],
        **({"proactivity": live_proactivity_camel()} if proactivity else {}),
        **({"contextWindowCompression": live_compression_camel()} if compression else {}),
    }
    if session_resumption:
        setup["sessionResumption"] = live_resumption_camel(resumption_handle)
    return {"setup": setup}


def rest_mint_payload(
    *,
    expire_at: datetime,
    new_session_expire_at: datetime,
    model: str,
    voice_id: str,
    safety: bool = True,
    session_resumption: bool = False,
    resumption_handle: str | None = None,
    proactivity: bool = True,
    compression: bool = True,
    personalization: Optional[Dict[str, Any]] = None,
    voice_language: Optional[str] = None,
) -> Dict[str, Any]:
    """AuthToken proto: bidiGenerateContentSetup, not liveConnectConstraints."""
    return {
        "uses": 1,
        "expireTime": _iso(expire_at),
        "newSessionExpireTime": _iso(new_session_expire_at),
        "bidiGenerateContentSetup": live_setup_message(
            model=model,
            voice_id=voice_id,
            safety=safety,
            session_resumption=session_resumption,
            resumption_handle=resumption_handle,
            proactivity=proactivity,
            compression=compression,
            personalization=personalization,
            voice_language=voice_language,
        )["setup"],
    }


def _iso(ts: datetime) -> str:
    return ts.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class VoiceTokenService:
    """Mints a real Gemini Live ephemeral token. Never invents vt_* stubs."""

    def __init__(
        self,
        *,
        poster: Optional[JsonPoster] = None,
        token_creator: Optional[TokenCreator] = None,
    ) -> None:
        self._poster = poster
        self._token_creator = token_creator

    def is_configured(self) -> bool:
        return bool(gemini_api_key())

    def mint_ephemeral_token(
        self,
        *,
        ttl_s: int | None = None,
        resumption_handle: str | None = None,
        voice_id: str | None = None,
        personalization: Dict[str, Any] | None = None,
        voice_language: str | None = None,
    ) -> Dict[str, Any]:
        api_key = gemini_api_key()
        if not api_key:
            raise AppError(
                "unavailable",
                "Live voice is not configured on this server. Use composer dictation instead.",
            )

        ttl = TOKEN_TTL_SECONDS if ttl_s is None else max(NEW_SESSION_TTL_SECONDS, min(TOKEN_TTL_SECONDS, int(ttl_s)))
        now = datetime.now(timezone.utc)
        expire_at = now + timedelta(seconds=ttl)
        new_session_expire_at = now + timedelta(seconds=NEW_SESSION_TTL_SECONDS)
        model = live_model_id()
        chosen_voice = (voice_id or "").strip()
        effective_voice_id = chosen_voice if chosen_voice in ALLOWED_VOICE_IDS else live_voice_id()
        safety = voice_safety_settings_enabled()
        session_resumption = True
        proactivity = voice_proactive_audio_enabled()
        compression = True
        handle = (resumption_handle or "").strip() or None

        token = ""
        api_version = DEFAULT_LIVE_API_VERSION
        for _ in range(6):
            try:
                token, api_version = self._mint(
                    api_key,
                    expire_at=expire_at,
                    new_session_expire_at=new_session_expire_at,
                    model=model,
                    voice_id=effective_voice_id,
                    safety=safety,
                    session_resumption=session_resumption,
                    resumption_handle=handle,
                    proactivity=proactivity,
                    compression=compression,
                    personalization=personalization,
                    voice_language=voice_language,
                )
                break
            except AppError as exc:
                if compression and rejects_context_window_compression(exc):
                    logger.warning("voice_token_compression_rejected retrying_without_field")
                    compression = False
                    continue
                if proactivity and rejects_proactivity(exc):
                    logger.warning("voice_token_proactivity_rejected retrying_without_field")
                    proactivity = False
                    continue
                if safety and rejects_safety_settings(exc):
                    logger.warning("voice_token_safety_settings_rejected retrying_without_field")
                    safety = False
                    continue
                if session_resumption and rejects_session_resumption(exc):
                    logger.warning("voice_token_session_resumption_rejected retrying_without_field")
                    session_resumption = False
                    handle = None
                    continue
                raise
        else:
            raise AppError(
                "unavailable",
                "Live voice could not start. The token provider rejected the session setup.",
            )

        logger.info(
            "voice_token_minted ttl_s=%s model=%s api=%s voice_id=%s safety_settings=%s "
            "session_resumption=%s proactivity=%s compression=%s",
            ttl,
            model,
            api_version,
            effective_voice_id,
            int(safety),
            int(session_resumption),
            int(proactivity),
            int(compression),
        )
        return {
            "token": token,
            "expires_at": _iso(expire_at),
            "new_session_expires_at": _iso(new_session_expire_at),
            "ws_url": constrained_ws_url(token, api_version=api_version),
            "model": model,
            "voice_id": effective_voice_id,
            # The browser sends exactly the setup the provider accepted, so a
            # rejected field cannot be re-sent on the WSS handshake.
            "setup": live_setup_message(
                model=model,
                voice_id=effective_voice_id,
                safety=safety,
                session_resumption=session_resumption,
                resumption_handle=handle,
                proactivity=proactivity,
                compression=compression,
                personalization=personalization,
                voice_language=voice_language,
            ),
            "setup_timeout_ms": SETUP_TIMEOUT_MS,
            "api_version": api_version,
            "safety_settings_applied": safety,
            "session_resumption_applied": session_resumption,
            "proactivity_applied": proactivity,
            "context_compression_applied": compression,
            "token_ttl_s": ttl,
        }

    def _mint(
        self,
        api_key: str,
        *,
        expire_at: datetime,
        new_session_expire_at: datetime,
        model: str,
        voice_id: str,
        safety: bool,
        session_resumption: bool,
        resumption_handle: str | None,
        proactivity: bool,
        compression: bool = True,
        personalization: Optional[Dict[str, Any]] = None,
        voice_language: Optional[str] = None,
    ) -> tuple[str, str]:
        if self._poster is not None:
            return self._mint_via_rest(
                api_key,
                rest_mint_payload(
                    expire_at=expire_at,
                    new_session_expire_at=new_session_expire_at,
                    model=model,
                    voice_id=voice_id,
                    safety=safety,
                    session_resumption=session_resumption,
                    resumption_handle=resumption_handle,
                    proactivity=proactivity,
                    compression=compression,
                    personalization=personalization,
                    voice_language=voice_language,
                ),
            )
        creator = self._token_creator or _create_token_via_sdk
        token = creator(
            api_key,
            _sdk_config(
                expire_at=expire_at,
                new_session_expire_at=new_session_expire_at,
                model=model,
                voice_id=voice_id,
                safety=safety,
                session_resumption=session_resumption,
                resumption_handle=resumption_handle,
                proactivity=proactivity,
                compression=compression,
                personalization=personalization,
                voice_language=voice_language,
            ),
        )
        return token, DEFAULT_LIVE_API_VERSION

    def _mint_via_rest(self, api_key: str, payload: Dict[str, Any]) -> tuple[str, str]:
        poster = self._poster or _post_auth_tokens
        headers = {"x-goog-api-key": api_key, "content-type": "application/json"}
        last_error: AppError | None = None
        for api_version, url in (("v1alpha", AUTH_TOKENS_URL), ("v1beta", AUTH_TOKENS_URL_BETA)):
            try:
                response_data = poster(url, headers, payload, 10.0)
                return _extract_token(response_data), api_version
            except AppError as exc:
                last_error = exc
                if api_version == "v1alpha" and _should_try_beta(exc):
                    logger.warning("voice_token_alpha_failed falling_back_to_v1beta")
                    continue
                raise
        assert last_error is not None
        raise last_error
