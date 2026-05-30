from __future__ import annotations

import re
from typing import TypedDict

from src.utils.ai_companion_config import DISTRESS_PATTERNS
from src.utils.ai_prompts import AI_COMPANION_SYSTEM_PROMPT, MEMORY_COMPACTION_PROMPT, REALITYCHECK_PROMPT, UNSCRAMBLE_PROMPT
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


def detect_language(text: str, history: list[ChatTurn] | None = None) -> str:
    sample = " ".join(
        part.strip()
        for part in ([text] + [item.get("text", "") for item in (history or [])])
        if part.strip()
    ).casefold()

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


def detect_distress_category(content: str) -> str | None:
    normalized = content.casefold()
    for category, patterns in DISTRESS_PATTERNS.items():
        for pattern in patterns:
            if re.search(pattern, normalized, re.IGNORECASE):
                return category
    return None


def _bold_hotline(hotline: str) -> str:
    m = re.search(r"(\+?\d[\d\-\s\(\)]+\d)", hotline)
    if m:
        num = m.group(1)
        return hotline.replace(num, f"**{num}**")
    return f"**{hotline}**"


def build_resource_payload(category_key: str) -> ResourcePayload:
    if category_key not in RESOURCE_SETS:
        category_key = "crisis"

    rs = RESOURCE_SETS[category_key]
    emoji = RESOURCE_EMOJIS.get(category_key, "")
    title = f"### {emoji} {rs['title']}"
    description = f"> {rs['description']}"
    hotline = _bold_hotline(rs["hotline"])
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
    links = [{"label": label, "url": url} for label, url in rs.get("links", ())]
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
    if language == "English":
        return ""
    return (
        f"Detected language: {language}. "
        f"Reply in {language} only unless the user explicitly asks for another language. "
        f"Keep the tone natural and simple in that language.\n\n"
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

    return (
        f"{focus} \n\n"
        "What seems most worth separating out is not the whole problem, but the one thought that is shouting the loudest. "
        "If you want, I can help you untangle that one thought with you."
    )


def _offline_realitycheck_response(user_prompt: str) -> str:
    lowered = user_prompt.casefold()
    if any(word in lowered for word in ("always", "never", "ruining", "everyone", "nobody", "disaster", "fail")):
        challenge = "That thought sounds absolute, but it may be the fear talking in all-or-nothing language."
    else:
        challenge = "What do you notice in the thought that feels like fear more than fact?"

    return (
        f"{challenge} \n\n"
        "A kinder question might be: if you stepped back for a second, what would this situation look like without the fear making it louder?"
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
    return generate_text(UNSCRAMBLE_PROMPT, text, history=history).strip()[:3500]


def run_realitycheck(text: str, history: list[ChatTurn] | None = None) -> str:
    return generate_text(REALITYCHECK_PROMPT, text, history=history).strip()[:3500]


def run_chat(text: str, history: list[ChatTurn] | None = None) -> str:
    category = detect_distress_category(text)
    if category == "crisis":
        payload = build_resource_payload("crisis")
        return payload["markdown"]

    return generate_text(AI_COMPANION_SYSTEM_PROMPT, text, history=history).strip()[:3500]
