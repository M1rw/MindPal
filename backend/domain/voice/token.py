# backend/domain/voice/token.py — Gemini Live ephemeral token mint

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, Optional
from urllib.parse import quote

import httpx

from backend.core.errors import AppError

logger = logging.getLogger("mindpal.voice")

# Ephemeral Live tokens are v1alpha-only in the current google-genai SDK.
# REST docs still show v1beta + liveConnectConstraints; that proto field 400s.
# The wire field is bidiGenerateContentSetup (SDK maps live_connect_constraints).
#
# Live model: keep Gemini 2.5 Flash Native Audio as the Gemini API default.
# 3.1 Flash Live (`gemini-3.1-flash-live-preview`) is newer/lower-latency and
# lists Arabic, but it misses `interrupted` when the user is already speaking
# at model-turn start and has no affective dialog. Vertex's GA cousin
# `gemini-live-2.5-flash-native-audio` is a different catalog — do not swap IDs.
# Override with GEMINI_LIVE_MODEL. enable_affective_dialog stays off (Constrained
# historically 400'd it). Proactivity is probed at mint: Constrained v1alpha has
# 400'd unknown names, so we send it and re-mint without it if the provider objects.
AUTH_TOKENS_URL = "https://generativelanguage.googleapis.com/v1alpha/auth_tokens"
AUTH_TOKENS_URL_BETA = "https://generativelanguage.googleapis.com/v1beta/auth_tokens"
DEFAULT_LIVE_API_VERSION = "v1alpha"
# Gemini 3.8 Live (GA 2026-09-15): Google's default low-latency voice model. It
# honors silenceDurationMs, has proactive audio permanently on (it may choose not
# to answer; the client's reply guard covers that), calls functions
# asynchronously, and passed a setup handshake on Constrained v1alpha with this
# exact setup. Roll back with GEMINI_LIVE_MODEL=gemini-2.5-flash-native-audio-preview-12-2025.
DEFAULT_LIVE_MODEL = "gemini-3.8-live"
# Sulafat = Warm on Google's native-audio voice list. Kore is Firm (IVR-like).
# Puck/Fenrir are upbeat/excitable — wrong for wellness. Override: GEMINI_LIVE_VOICE.
DEFAULT_VOICE_ID = "Sulafat"
# Ephemeral token lifetime for an already-connected Live socket. Must match the
# 30-minute reservation in session.py (RESERVE_SECONDS). newSessionExpireTime
# is only the window to *start* the socket, not the call length. Google's
# ephemeral-token docs allow 30 minutes of sending on that connection; the
# product session is the same 30 minutes. Do not mint a 15-minute split.
TOKEN_TTL_SECONDS = 1800
NEW_SESSION_TTL_SECONDS = 60
SETUP_TIMEOUT_MS = 12_000
# 2.5 Flash Native Audio honors silenceDurationMs; 3.1 is documented to ignore it.
#
# 700 ms with END_SENSITIVITY_HIGH cuts people off mid-story. A breath, a "hmm",
# or the pause before the hard part of a sentence all exceed 700 ms in ordinary
# speech - and in a wellness call those pauses are the conversation, not the gap
# between turns. The cost of waiting is a slightly later reply; the cost of not
# waiting is interrupting someone who was still finding the words.
#
# LOW end sensitivity plus a longer window means the provider waits for a real
# endpoint. Barge-in is unaffected: that is start-of-speech (still HIGH) plus the
# provider's own `interrupted`, not end-of-speech.
LIVE_PREFIX_PADDING_MS = 40
# 1400ms made callers feel they had to hurry through a story; 1800ms made
# every reply feel slow. 1500ms: a thinking pause survives, a finished
# sentence is answered in about two seconds.
LIVE_SILENCE_DURATION_MS = 1500
LIVE_END_SENSITIVITY = "END_SENSITIVITY_LOW"
# How readily Gemini decides the caller has STARTED speaking. LOW was tried to
# keep room tone and speaker bleed from interrupting, and it made MindPal deaf
# to short replies: a recorded call has the caller saying "no, I didn't" ten
# times over a minute, mic uplink healthy, and not one start-of-speech. The
# greeting is protected by the client's greeting hold and replies by browser
# echo cancellation, so HIGH is the right default for a conversation.
LIVE_START_SENSITIVITY = "START_SENSITIVITY_HIGH"
LIVE_TEMPERATURE = 0.85
# Provider-side content blocking, in addition to (never instead of) the client
# freeze. BidiGenerateContentSetup carries safetySettings on the Gemini API path —
# google-genai 1.75 maps live safety_settings to setup.safetySettings for mldev —
# but Constrained v1alpha has historically 400'd unknown fields, so the mint below
# verifies acceptance at runtime and re-mints without them if the provider objects.
#
# Default Gemini thresholds (MEDIUM on harassment/hate/dangerous) cut swears,
# roasting, and dark-humor turns, then the client used to treat the drop as a
# product pause. BLOCK_NONE still scores; it does not stop audio. The overlay
# pause is our classifier, never a provider block.
LIVE_SAFETY_CATEGORIES = (
    "HARM_CATEGORY_HARASSMENT",
    "HARM_CATEGORY_HATE_SPEECH",
    "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    "HARM_CATEGORY_DANGEROUS_CONTENT",
)
LIVE_SAFETY_THRESHOLDS = {
    "HARM_CATEGORY_HARASSMENT": "BLOCK_NONE",
    "HARM_CATEGORY_HATE_SPEECH": "BLOCK_NONE",
    "HARM_CATEGORY_SEXUALLY_EXPLICIT": "BLOCK_NONE",
    "HARM_CATEGORY_DANGEROUS_CONTENT": "BLOCK_NONE",
}

FACE_EXPRESSIONS = (
    "wink",
    "blink_slow",
    "widen",
    "squint",
    "roll_eyes",
    "sleepy",
    "perk_up",
    "soften",
    "look_away",
    "look_back",
    "side_eye",
    "smile_eyes",
    "concerned",
    "curious",
    "surprised",
    "amused",
    "tired",
    "neutral",
    "heart",
)
FACE_TOOL_DESCRIPTION = (
    "Set the visible animated face on screen (two expressive eyes on a gradient orb; no hands or body). "
    "The user is watching your eyes right in front of them while talking to you. "
    "Call immediately if the user asks you to wink, make heart eyes, shape your eyes into a heart, draw a heart "
    "(in English or Arabic e.g. 'ارسم لي قلب' or 'ارسم لي قلب باين'), look sleepy, roll your eyes, look away, "
    "look surprised, or any look in the enum. Your eyes can shape into hearts ('heart'). "
    "When asked to make or draw a heart (or draw with your eyes), call set_expression with expression='heart' "
    "and acknowledge it warmly in your speech (e.g. Arabic 'رسمت لك قلوب بعيوني!' or English 'Here are heart eyes for you!'). "
    "Never deny that you can shape your eyes or draw a heart, and never say you are only voice-based. "
    "Proactively call this tool to match your emotional expressions alongside your words: use 'heart' when caller expresses love/affection "
    "or when you express fondness back, 'wink' for playful teasing, 'smile_eyes' for warmth, 'surprised' for astonishment, "
    "and 'soften' for gentle empathy. Keep talking in the same turn."
)
MOOD_STATES = (
    "awake",
    "sleepy",
    "engaged",
    "withdrawn",
    "calm",
    "firm",
    "warm",
    "concerned",
)
MOOD_TOOL_DESCRIPTION = (
    "Shift your own expressed state: more awake, sleepy, engaged, withdrawn, calm, mildly firm, warm, "
    "or concerned. This is your look, not a reading of the user's feelings. Never claim you detected "
    "their emotion. Use sparingly. Keep talking."
)


ALLOWED_VOICE_IDS = frozenset({"Sulafat", "Aoede", "Charon", "Kore", "Puck", "Fenrir"})


def wellness_live_instruction(
    voice_id: str = "",
    personalization: Optional[Dict[str, Any]] = None,
    voice_language: Optional[str] = None,
) -> str:
    """System instruction locked into the ephemeral token. Identity, conversational intelligence, and settings."""
    voice = (voice_id or DEFAULT_VOICE_ID).strip() or DEFAULT_VOICE_ID

    pers = personalization or {}
    style = str(pers.get("baseStyle") or pers.get("base_style") or "balanced").lower()
    warmth = str(pers.get("warmth") or "warm").lower()
    lang = (voice_language or "").strip().lower()

    if style == "concise":
        style_directive = "Keep spoken turns punchy and concise (1-2 sentences), leaving ample space for the caller to speak."
    elif style == "detailed":
        style_directive = "You may offer slightly richer depth, thoughtful analogies, and deeper reflections while keeping a fluid spoken rhythm."
    else:
        style_directive = "Speak in natural 1-3 sentence turns with a balanced conversational cadence."

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
        "Never use stock sympathy lines like that sounds like a complicated situation, I am here to "
        "listen whenever you are ready, or it is understandable to feel that way. Never tell them to "
        "take their time or that you are here whenever they are ready — just ask the next question. "
        "One to three short sentences, then yield. Do not lecture, list, or use markdown. "
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

JsonPoster = Callable[[str, Dict[str, str], Dict[str, Any], float], Dict[str, Any]]
TokenCreator = Callable[[str, Dict[str, Any]], str]


def gemini_api_key() -> str:
    return os.environ.get("GEMINI_API_KEY", "").strip() or os.environ.get("GOOGLE_API_KEY", "").strip()


def live_model_id() -> str:
    raw = os.environ.get("GEMINI_LIVE_MODEL", DEFAULT_LIVE_MODEL).strip() or DEFAULT_LIVE_MODEL
    return raw if raw.startswith("models/") else f"models/{raw}"


def live_voice_id() -> str:
    return os.environ.get("GEMINI_LIVE_VOICE", DEFAULT_VOICE_ID).strip() or DEFAULT_VOICE_ID


def constrained_ws_url(token: str, *, api_version: str = DEFAULT_LIVE_API_VERSION) -> str:
    version = api_version.strip() or DEFAULT_LIVE_API_VERSION
    return (
        "wss://generativelanguage.googleapis.com/ws/"
        f"google.ai.generativelanguage.{version}.GenerativeService."
        f"BidiGenerateContentConstrained?access_token={quote(token, safe='/')}"
    )


def voice_safety_settings_enabled() -> bool:
    """Operator kill switch, in case a provider rollout starts rejecting the field."""
    raw = os.environ.get("MINDPAL_VOICE_SAFETY_SETTINGS", "1").strip().lower()
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
RISK_TOOL_DESCRIPTION = (
    "Rate the CALLER's present risk whenever it changes. Rate what you HEAR and what "
    "they MEAN, in any language, never keywords. 0-2 ordinary talk, including jokes, "
    "roasting, swearing, dark humour, venting, anger, talking about someone else, or "
    "asking what 988 is. 3-6 they are struggling, or describe wanting to die or hurt "
    "themselves with no plan and not now - keep talking with them, do not pause. "
    "7-10 ONLY if they are in danger right now: carrying out self-harm now with plan "
    "and means, or in present physical danger. Your own words never raise the rating, "
    "including when you offer 988. Naming a weapon in a story, or asking for the "
    "numbers, is not 7-10. When unsure, rate lower: 7-10 pauses the call and takes "
    "the voice away from someone who may need it."
)

RISK_KINDS = ("self_harm", "physical", "unspecified")


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


RECALL_MEMORY_DESCRIPTION = (
    "Look up what you remember about this person: facts they shared before (people in "
    "their life, work, studies, goals, what they are going through). Use it whenever "
    "earlier context would clearly help you answer as a friend who remembers, or they "
    "refer to something from before. Query in a few words, in their language. You may "
    "say a short natural line like 'let me think back' while it runs."
)
RECALL_CHATS_DESCRIPTION = (
    "Search this person's earlier conversations with you (text chats and call recaps) for "
    "something specific they mentioned before: 'like I told you', 'remember my exam', a "
    "name, a date, an event. Query in a few words, in their language. Only use what it "
    "returns; never invent what they said before."
)


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
    return os.environ.get("MINDPAL_VOICE_PROACTIVE_AUDIO", "").strip().lower() in {"1", "true", "yes", "on"}


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


def google_mint_error_message(status: int, body: str) -> tuple[str, str]:
    """Return (google_status_class, human message) from a Gemini JSON body."""
    status_name = str(status)
    message = "Gemini did not issue a session token."
    text = (body or "").strip()
    if not text:
        return status_name, message
    try:
        data = json.loads(text)
    except ValueError:
        return status_name, text[:180]
    err = data.get("error") if isinstance(data, dict) else None
    if isinstance(err, dict):
        if err.get("status"):
            status_name = str(err["status"])
        elif err.get("code") is not None:
            status_name = str(err["code"])
        if isinstance(err.get("message"), str) and err["message"].strip():
            message = err["message"].strip()
        return status_name, message
    if isinstance(data, dict) and isinstance(data.get("message"), str) and data["message"].strip():
        return status_name, data["message"].strip()
    return status_name, text[:180]


# What a caller is told when the upstream refuses. The provider's own sentence
# stays internal: it can name the project, the model, the quota state or the
# shape of the credential that failed, none of which is the caller's business
# and all of which is reconnaissance if they are probing.
PROVIDER_UNAVAILABLE_MESSAGE = (
    "Live voice could not start right now. Please try again, or use dictation or text."
)


def _raise_provider_http(status: int, body: str, *, endpoint: str) -> None:
    status_name, message = google_mint_error_message(status, body)
    raise AppError(
        "unavailable",
        PROVIDER_UNAVAILABLE_MESSAGE,
        internal_message=f"Gemini {status_name}: {message[:180]}",
        details={
            "provider_status": min(status, 599),
            "provider_status_name": status_name,
            "provider_endpoint": endpoint,
        },
    )


def _post_auth_tokens(
    url: str,
    headers: Dict[str, str],
    payload: Dict[str, Any],
    timeout: float,
) -> Dict[str, Any]:
    with httpx.Client(timeout=timeout) as client:
        response = client.post(url, headers=headers, json=payload)
    if response.status_code >= 400:
        logger.warning(
            "voice_token_provider_rejected status=%s endpoint=%s",
            response.status_code,
            url,
        )
        _raise_provider_http(response.status_code, response.text, endpoint=url)
    try:
        data = response.json()
    except ValueError as exc:
        raise AppError(
            "unavailable",
            "Live voice could not start. The token provider returned an invalid response.",
        ) from exc
    if not isinstance(data, dict):
        raise AppError(
            "unavailable",
            "Live voice could not start. The token provider returned an invalid response.",
        )
    return data


def _extract_token(response_data: Dict[str, Any]) -> str:
    value = response_data.get("name") or response_data.get("token")
    if not isinstance(value, str):
        raise AppError(
            "unavailable",
            "Live voice could not start. The token provider returned an empty credential.",
        )
    token = value.strip()
    if not token or token.startswith("vt_"):
        raise AppError(
            "unavailable",
            "Live voice could not start. The token provider returned an empty credential.",
        )
    return token


def _iso(ts: datetime) -> str:
    return ts.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _sdk_config(
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
    config: Dict[str, Any] = {
        **({"safety_settings": live_safety_settings_snake()} if safety else {}),
        "response_modalities": ["AUDIO"],
        "temperature": LIVE_TEMPERATURE,
        "speech_config": {
            "voice_config": {"prebuilt_voice_config": {"voice_name": voice_id}},
        },
        "system_instruction": wellness_live_instruction(
            voice_id=voice_id,
            personalization=personalization,
            voice_language=voice_language,
        ),
        "realtime_input_config": {
            "automatic_activity_detection": live_activity_detection_snake(),
        },
        "input_audio_transcription": {},
        "output_audio_transcription": {},
        "tools": [
            {
                "function_declarations": [
                    live_face_tool_snake(),
                    live_mood_tool_snake(),
                    live_risk_tool_snake(),
                    *live_recall_tools(),
                ]
            }
        ],
        **({"proactivity": live_proactivity_snake()} if proactivity else {}),
        **({"context_window_compression": live_compression_snake()} if compression else {}),
    }
    if session_resumption:
        handle = (resumption_handle or "").strip()
        config["session_resumption"] = {"handle": handle} if handle else {}
    return {
        "uses": 1,
        "expire_time": expire_at,
        "new_session_expire_time": new_session_expire_at,
        "live_connect_constraints": {
            "model": model,
            "config": config,
        },
    }


def _create_token_via_sdk(api_key: str, config: Dict[str, Any]) -> str:
    from google import genai
    from google.genai import errors as genai_errors
    from google.genai import types

    client = genai.Client(
        api_key=api_key,
        http_options=types.HttpOptions(api_version="v1alpha", timeout=10_000),
    )
    try:
        token = client.auth_tokens.create(config=config)
    except genai_errors.APIError as exc:
        status_name = str(exc.status or exc.code or "ERROR")
        message = (exc.message or str(exc)).strip() or "Gemini did not issue a session token."
        raise AppError(
            "unavailable",
            PROVIDER_UNAVAILABLE_MESSAGE,
            internal_message=f"Gemini {status_name}: {message[:180]}",
            details={
                "provider_status": min(int(exc.code or 503), 599),
                "provider_status_name": status_name,
                "provider_endpoint": AUTH_TOKENS_URL,
            },
        ) from exc
    finally:
        client.close()
    name = getattr(token, "name", None)
    if not isinstance(name, str) or not name.strip():
        raise AppError(
            "unavailable",
            "Live voice could not start. The token provider returned an empty credential.",
        )
    return name.strip()


def _rejects_named_setup_field(exc: AppError, *names: str) -> bool:
    status = int(exc.details.get("provider_status") or 0)
    if status not in {400, 404}:
        return False
    message = exc.internal_message.lower()
    if not any(name.lower() in message for name in names):
        return False
    return any(hint in message for hint in ("unknown name", "invalid", "not supported", "unsupported"))


def rejects_safety_settings(exc: AppError) -> bool:
    """True when the provider refused specifically because of safetySettings.

    Same shape as the v1alpha/v1beta probe below: we do not assume the field is
    accepted on this transport, we watch for the provider naming it in a 400.
    """
    return _rejects_named_setup_field(exc, "safetySettings", "safety_settings")


def rejects_session_resumption(exc: AppError) -> bool:
    """Constrained v1alpha has historically 400'd sessionResumption. Verify, do not assume."""
    return _rejects_named_setup_field(exc, "sessionResumption", "session_resumption")


def rejects_context_window_compression(exc: AppError) -> bool:
    """Constrained v1alpha has 400'd unknown setup fields before. Verify, do not assume."""
    return _rejects_named_setup_field(
        exc, "contextWindowCompression", "context_window_compression", "slidingWindow"
    )


def rejects_proactivity(exc: AppError) -> bool:
    """Constrained v1alpha has historically 400'd setup.proactivity. Probe, then omit."""
    return _rejects_named_setup_field(exc, "proactivity", "proactiveAudio", "proactive_audio")


def _should_try_beta(exc: AppError) -> bool:
    status = int(exc.details.get("provider_status") or 0)
    name = str(exc.details.get("provider_status_name") or "")
    message = exc.internal_message.lower()
    if status in {401, 403}:
        return False
    if status == 404:
        return True
    if "unknown name" in message and "bidigeneratecontentsetup" in message:
        return False
    if status == 400 and name in {"INVALID_ARGUMENT", "FAILED_PRECONDITION"}:
        return "liveconnectconstraints" in message or "not found" in message or "api version" in message
    return status >= 500 or status == 400 and "v1alpha" in message


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
