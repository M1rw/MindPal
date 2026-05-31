from __future__ import annotations

import re
from typing import Final, TypedDict

from src.utils.ai_companion_config import DISTRESS_PATTERNS
from src.utils.ai_prompts import AI_COMPANION_SYSTEM_PROMPT, MEMORY_COMPACTION_PROMPT, REALITYCHECK_PROMPT, UNSCRAMBLE_PROMPT
from src.utils.ai_prompts import RESOURCE_INTENT_PROMPT
from src.utils.ai_providers import (
    generate_with_google,
    generate_with_groq,
    generate_with_hugging_face,
    generate_with_openrouter,
)
from src.utils.config import RESOURCE_EMOJIS, RESOURCE_SETS


class ResourcePayload(TypedDict):
    category: str
    markdown: str
    links: list[dict[str, str]]


class ChatTurn(TypedDict):
    role: str
    text: str


class CrisisRegionProfile(TypedDict):
    label: str
    emergency: str
    hotline: str
    links: tuple[tuple[str, str], ...]


CRISIS_REGION_PROFILES: Final[dict[str, CrisisRegionProfile]] = {
    "us_ca": {
        "label": "U.S./Canada",
        "emergency": "If you may act on suicidal thoughts right now, call 911 immediately.",
        "hotline": "988 Suicide & Crisis Lifeline: Call or text 988",
        "links": (
            ("988 Suicide & Crisis Lifeline", "https://988lifeline.org/"),
            ("Crisis Text Line", "https://www.crisistextline.org/"),
        ),
    },
    "uk_ie": {
        "label": "UK/Ireland",
        "emergency": "If you are in immediate danger, call 999 or 112 now.",
        "hotline": "Samaritans: Call 116 123 (24/7)",
        "links": (
            ("Samaritans", "https://www.samaritans.org/"),
            ("NHS Urgent Mental Health Help", "https://www.nhs.uk/nhs-services/mental-health-services/where-to-get-urgent-help-for-mental-health/"),
        ),
    },
    "au": {
        "label": "Australia",
        "emergency": "If there is immediate risk, call 000 now.",
        "hotline": "Lifeline Australia: Call 13 11 14",
        "links": (
            ("Lifeline Australia", "https://www.lifeline.org.au/"),
            ("Beyond Blue", "https://www.beyondblue.org.au/"),
        ),
    },
    "in": {
        "label": "India",
        "emergency": "If you are in immediate danger, call local emergency services now.",
        "hotline": "Kiran Mental Health Helpline: 1800-599-0019",
        "links": (
            ("Kiran Helpline", "https://www.mohfw.gov.in/"),
            ("AASRA", "http://www.aasra.info/"),
        ),
    },
    "global": {
        "label": "Global",
        "emergency": "If you may be in immediate danger, call your local emergency number now.",
        "hotline": "Find local crisis lines via Befrienders Worldwide",
        "links": (
            ("Befrienders Worldwide", "https://www.befrienders.org/"),
            ("Crisis Text Line", "https://www.crisistextline.org/"),
        ),
    },
}


def _normalize_region_hint(region_hint: str | None) -> str | None:
    if not region_hint:
        return None
    value = region_hint.strip().casefold().replace("-", "_")
    alias_map: dict[str, str] = {
        "us": "us_ca",
        "usa": "us_ca",
        "united_states": "us_ca",
        "united states": "us_ca",
        "ca": "us_ca",
        "canada": "us_ca",
        "uk": "uk_ie",
        "gb": "uk_ie",
        "great_britain": "uk_ie",
        "great britain": "uk_ie",
        "united_kingdom": "uk_ie",
        "united kingdom": "uk_ie",
        "ie": "uk_ie",
        "ireland": "uk_ie",
        "au": "au",
        "australia": "au",
        "in": "in",
        "india": "in",
        "global": "global",
    }
    return alias_map.get(value, value if value in CRISIS_REGION_PROFILES else None)


def resolve_crisis_region(text: str, history: list[ChatTurn] | None = None, region_hint: str | None = None) -> str:
    normalized_hint = _normalize_region_hint(region_hint)
    if normalized_hint:
        return normalized_hint

    sample = " ".join(
        part for part in [text.strip(), " ".join(item.get("text", "").strip() for item in (history or [])[-8:])] if part
    ).casefold()

    keyword_map: tuple[tuple[str, tuple[str, ...]], ...] = (
        ("us_ca", ("united states", "usa", "u.s.", "us", "canada", "toronto", "vancouver", "new york")),
        ("uk_ie", ("united kingdom", "uk", "england", "scotland", "wales", "ireland", "dublin", "london")),
        ("au", ("australia", "sydney", "melbourne", "brisbane", "perth")),
        ("in", ("india", "mumbai", "delhi", "bengaluru", "bangalore")),
    )

    for region_code, tokens in keyword_map:
        if any(token in sample for token in tokens):
            return region_code

    return "global"


def _detect_language_from_sample(sample: str) -> str:
    sample = sample.casefold()

    if not sample:
        return "English"

    # Script-based detection for the most common non-Latin scripts.
    for char in sample:
        codepoint = ord(char)
        if 0x0600 <= codepoint <= 0x06FF or 0x0750 <= codepoint <= 0x077F or 0x08A0 <= codepoint <= 0x08FF:
            return "Arabic"
        if 0x0400 <= codepoint <= 0x04FF:
            return "Russian"
        if 0x0590 <= codepoint <= 0x05FF:
            return "Hebrew"
        if 0xAC00 <= codepoint <= 0xD7AF:
            return "Korean"
        if 0x3040 <= codepoint <= 0x309F or 0x30A0 <= codepoint <= 0x30FF:
            return "Japanese"
        if 0x4E00 <= codepoint <= 0x9FFF:
            return "Chinese"

    # Lightweight keyword / accent heuristics for Latin-script languages.
    heuristics: tuple[tuple[str, tuple[str, ...]], ...] = (
        ("Spanish", ("¿", "¡", " que ", " estoy ", " porque ", " no ", " quiero ", " me siento ", " ansiedad ", " depresi")),
        ("French", (" je ", " ne ", " pas ", " suis ", " parce que ", " envie ", " anxi", " déprim", " épuis")),
        ("Portuguese", (" não ", " estou ", " porque ", " quero ", " ansiedade", " depress", " exaust")),
        ("German", (" ich ", " nicht ", " weil ", " füh", " depression", " angst ")),
        ("Italian", (" non ", " sono ", " perché ", " voglio ", " ansia", " depresso")),
        ("Arabic", (" أنا ", " لا ", " أريد ", " أشعر ", " حزين", " قلق")),
    )

    for language, tokens in heuristics:
        if any(token in sample for token in tokens):
            return language

    return "English"


def detect_language(text: str, history: list[ChatTurn] | None = None) -> str:
    current_sample = text.strip()
    if current_sample:
        current_language = _detect_language_from_sample(current_sample)
        if any(char.isalpha() for char in current_sample):
            return current_language

    history_sample = " ".join(
        item.get("text", "").strip()
        for item in (history or [])
        if item.get("text", "").strip()
    )
    return _detect_language_from_sample(history_sample)


def detect_distress_category(content: str) -> str | None:
    normalized = content.casefold()
    for category, patterns in DISTRESS_PATTERNS.items():
        for pattern in patterns:
            if re.search(pattern, normalized, re.IGNORECASE):
                return category
    return None


def _bold_hotline(hotline: str) -> str:
    searchable = hotline.replace("(24/7)", " ").replace("24/7", " ")
    m = re.search(r"(\+?\d[\d\-\s\(\)]*\d)", searchable)
    if m:
        num = m.group(1)
        return hotline.replace(num, f"**{num}**")
    return f"**{hotline}**"


def build_resource_payload(category_key: str, region: str | None = None) -> ResourcePayload:
    if category_key not in RESOURCE_SETS:
        category_key = "crisis"

    rs = RESOURCE_SETS[category_key]
    emoji = RESOURCE_EMOJIS.get(category_key, "")
    title = f"### {emoji} {rs['title']}"
    description = f"> {rs['description']}"
    if category_key == "crisis":
        region_code = _normalize_region_hint(region) or "global"
        region_profile = CRISIS_REGION_PROFILES.get(region_code, CRISIS_REGION_PROFILES["global"])
        description = f"> {rs['description']} {region_profile['emergency']}"
        hotline = _bold_hotline(region_profile["hotline"])
        links_source = region_profile["links"]
    else:
        hotline = _bold_hotline(rs["hotline"])
        links_source = rs.get("links", ())
    tips_lines = "\n".join(f"- {tip}" for tip in rs.get("tips", ()))
    markdown = "\n".join(
        [
            title,
            "",
            description,
            "",
            f"**Hotline:** {hotline}",
            "",
            "**Coping Tips:**",
            tips_lines,
        ]
    )
    links = [{"label": label, "url": url} for label, url in links_source]
    return {"category": category_key, "markdown": markdown, "links": links}


def _build_history_context(history: list[ChatTurn] | None) -> str:
    if not history:
        return ""

    turns: list[str] = []
    for item in history[-8:]:
        role = item.get("role", "user").strip().casefold()
        text = item.get("text", "").strip()
        if not text:
            continue
        label = "User" if role == "user" else "MindPal"
        turns.append(f"{label}: {text}")

    if not turns:
        return ""

    return "Conversation so far:\n" + "\n".join(turns) + "\n\n"


def _build_memory_transcript(text: str, history: list[ChatTurn] | None) -> str:
    turns: list[str] = []
    for item in (history or [])[-16:]:
        role = item.get("role", "user").strip().casefold()
        content = item.get("text", "").strip()
        if not content:
            continue
        label = "User" if role == "user" else "MindPal"
        turns.append(f"{label}: {content}")

    if text.strip():
        turns.append(f"User: {text.strip()}")

    return "\n".join(turns)


def _summarize_memory(text: str, history: list[ChatTurn] | None) -> str:
    transcript = _build_memory_transcript(text, history)
    if not transcript.strip():
        return ""

    try:
        summary = generate_with_google(MEMORY_COMPACTION_PROMPT, transcript)
    except Exception:
        summary = _try_remote_fallbacks(MEMORY_COMPACTION_PROMPT, transcript)

    cleaned = summary.strip()
    if not cleaned:
        return ""

    if not cleaned.casefold().startswith("relevant memory:"):
        cleaned = "Relevant memory:\n" + cleaned

    return cleaned.rstrip() + "\n\n"


def _build_memory_context(text: str, history: list[ChatTurn] | None) -> str:
    return _summarize_memory(text, history)


def _build_language_context(language: str) -> str:
    return (
        f"Language lock: {language}. "
        f"Reply in {language} only unless the user explicitly asks for another language. "
        f"Do not switch languages mid-reply. Keep the tone natural and simple in that language.\n\n"
    )


def _offline_unscramble_response(user_prompt: str) -> str:
    lowered = user_prompt.casefold()
    if any(word in lowered for word in ("work", "job", "boss", "deadline")):
        focus = "It sounds like the pressure is getting bigger than the task itself."
    elif any(word in lowered for word in ("school", "class", "exam", "study")):
        focus = "It sounds like the whole school load is collapsing into one heavy feeling."
    elif any(word in lowered for word in ("relationship", "partner", "friend", "family")):
        focus = "It sounds like the relationship part is carrying most of the emotional weight."
    else:
        focus = "It sounds like your mind is trying to hold too many things at once."

    return "\n".join(
        [
            "**Thought:** " + focus,
            "**Distortion:** The pressure is getting amplified into a total-threat story.",
            "**Evidence For:** There is real stress and uncertainty right now.",
            "**Evidence Against:** This feeling has shifted before, and not every fear outcome actually happened.",
            "**Balanced Reframe:** This is difficult, but it is one heavy moment, not the whole future.",
            "**Next Tiny Action:** Name one concrete task that can be done in the next 10 minutes and do only that.",
        ]
    )


def _offline_realitycheck_response(user_prompt: str) -> str:
    lowered = user_prompt.casefold()
    if any(word in lowered for word in ("always", "never", "ruining", "everyone", "nobody", "disaster", "fail")):
        challenge = "That thought sounds absolute, but it may be the fear talking in all-or-nothing language."
    else:
        challenge = "What do you notice in the thought that feels like fear more than fact?"

    return "\n".join(
        [
            "**Thought:** " + challenge,
            "**Distortion:** The mind may be using all-or-nothing language to predict the worst.",
            "**Evidence For:** Something important is at stake and emotions are high.",
            "**Evidence Against:** There are likely neutral or positive facts that the fear lens is skipping.",
            "**Balanced Reframe:** Fear can be loud without being fully accurate.",
            "**Next Tiny Action:** Write one fact that supports the fear and one fact that softens it.",
        ]
    )


def _ensure_cbt_structure(response: str, user_prompt: str) -> str:
    labels = (
        "**Thought:**",
        "**Distortion:**",
        "**Evidence For:**",
        "**Evidence Against:**",
        "**Balanced Reframe:**",
        "**Next Tiny Action:**",
    )
    value = (response or "").strip()
    if not value:
        value = _offline_unscramble_response(user_prompt)

    if all(label.casefold() in value.casefold() for label in labels):
        return value

    # Fallback: keep user-facing consistency even if provider drifts from requested format.
    single_line = " ".join(value.splitlines()).strip()
    return "\n".join(
        [
            f"**Thought:** {user_prompt.strip()[:240] or 'I feel overwhelmed right now.'}",
            "**Distortion:** The mind may be overgeneralizing or predicting the worst-case outcome.",
            "**Evidence For:** There are valid stress signals and emotional pain present.",
            "**Evidence Against:** Not every feared outcome is certain, and there are still options available.",
            f"**Balanced Reframe:** {single_line[:280] if single_line else 'This is hard, but it is workable one step at a time.'}",
            "**Next Tiny Action:** Take one small grounded step (water, 3 breaths, or one 10-minute task).",
        ]
    )


def _offline_response(system_prompt: str, user_prompt: str) -> str:
    if "brain-fog translator" in system_prompt.casefold():
        return _offline_unscramble_response(user_prompt)
    if "cognitive mirror" in system_prompt.casefold():
        return _offline_realitycheck_response(user_prompt)
    return "I couldn't reach the AI service, but I'm still here. Try again in a moment."


def _clean_companion_response(text: str) -> str:
    value = text.strip()

    generic_prefixes = (
        "i'm really sorry to hear that",
        "i am really sorry to hear that",
        "i'm sorry to hear that",
        "i am sorry to hear that",
        "i'm really sorry",
        "i am really sorry",
        "i'm sorry",
        "i am sorry",
        "i hear you",
        "i understand how that feels",
        "i'm here to listen",
        "it sounds like",
    )

    lowered = value.casefold()
    for prefix in generic_prefixes:
        if lowered.startswith(prefix):
            value = value[len(prefix):].lstrip(" .,-:;\n\t")
            break

    if not value:
        value = "That sounds heavy. Tell me what part hurts the most right now."

    return value


def _try_remote_fallbacks(system_prompt: str, user_prompt: str) -> str:
    for provider in (generate_with_openrouter, generate_with_groq, generate_with_hugging_face):
        try:
            return provider(system_prompt, user_prompt)
        except Exception:
            continue
    return _offline_response(system_prompt, user_prompt)


def generate_text(system_prompt: str, user_prompt: str, history: list[ChatTurn] | None = None) -> str:
    language = detect_language(user_prompt, history=history)
    memory_context = _build_memory_context(user_prompt, history)
    user_payload = _build_language_context(language) + memory_context + _build_history_context(history) + user_prompt
    try:
        response = generate_with_google(system_prompt, user_payload)
    except Exception:
        response = _try_remote_fallbacks(system_prompt, user_payload)

    if system_prompt == AI_COMPANION_SYSTEM_PROMPT:
        return _clean_companion_response(response)

    return response


def run_unscramble(text: str, history: list[ChatTurn] | None = None) -> str:
    raw = generate_text(UNSCRAMBLE_PROMPT, text, history=history).strip()
    return _ensure_cbt_structure(raw, text)[:3500]


def run_realitycheck(text: str, history: list[ChatTurn] | None = None) -> str:
    raw = generate_text(REALITYCHECK_PROMPT, text, history=history).strip()
    return _ensure_cbt_structure(raw, text)[:3500]


def run_chat(text: str, history: list[ChatTurn] | None = None) -> str:
    category = detect_distress_category(text)
    if category == "crisis":
        payload = build_resource_payload("crisis")
        return payload["markdown"]

    return generate_text(AI_COMPANION_SYSTEM_PROMPT, text, history=history).strip()[:3500]


def detect_resource_intent(text: str, history: list[ChatTurn] | None = None) -> bool:
    """Ask the model (with language lock) whether the user is requesting resources.

    Returns True when the AI's first line begins with 'Yes' (case-insensitive) or clearly affirms resource intent.
    Falls back to a simple heuristic if remote providers fail.
    """
    try:
        resp = generate_text(RESOURCE_INTENT_PROMPT, text, history=history)
    except Exception:
        resp = _try_remote_fallbacks(RESOURCE_INTENT_PROMPT, text)

    first_line = (resp or "").strip().splitlines()[0] if resp else ""
    lowered = first_line.casefold()
    if lowered.startswith("yes") or "sí" in lowered or lowered.startswith("oui") or "si " in lowered:
        return True

    # Safe heuristics: common request tokens
    lowered_text = (text or "").casefold()
    tokens = ("resource", "resources", "hotline", "help line", "helpline", "coping", "tips", "support", "links", "crisis")
    if any(tok in lowered_text for tok in tokens):
        return True

    return False
