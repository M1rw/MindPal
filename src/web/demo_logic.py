from __future__ import annotations

import re
from typing import TypedDict

from src.utils.ai_companion_config import DISTRESS_PATTERNS
from src.utils.ai_prompts import AI_COMPANION_SYSTEM_PROMPT, REALITYCHECK_PROMPT, UNSCRAMBLE_PROMPT
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


def _offline_unscramble_response(user_prompt: str) -> str:
    lowered = user_prompt.casefold()
    control_items = [
        "What you do next.",
        "Who you contact for support.",
        "Whether you take one tiny step instead of solving everything at once.",
    ]

    if any(word in lowered for word in ("work", "job", "boss", "deadline")):
        control_items[0] = "How you break the next task into something small."
    elif any(word in lowered for word in ("school", "class", "exam", "study")):
        control_items[0] = "Which assignment or topic you focus on first."
    elif any(word in lowered for word in ("relationship", "partner", "friend", "family")):
        control_items[0] = "How you phrase one honest message or boundary."

    return (
        "Things in your control:\n"
        + "\n".join(f"- {item}" for item in control_items)
        + "\n\nThings out of your control:\n"
        + "- Other people's reactions.\n"
        + "- The entire problem all at once.\n"
        + "- The fact that your brain is overwhelmed right now.\n\n"
        "One microscopic next step:\n"
        "- Put one sentence from the brain dump into a note titled \"next\"."
    )


def _offline_realitycheck_response(user_prompt: str) -> str:
    lowered = user_prompt.casefold()
    if any(word in lowered for word in ("always", "never", "ruining", "everyone", "nobody", "disaster", "fail")):
        challenge = "That thought sounds absolute, but is it really 100% true, or is your mind filling in the worst-case version?"
    else:
        challenge = "What evidence would you have to see before you'd treat this thought as a fact instead of a fear?"

    return (
        f"{challenge}\n\n"
        "One question:\n"
        "- If your best friend had the same thought, what would you tell them to check first?"
    )


def _offline_response(system_prompt: str, user_prompt: str) -> str:
    if "brain-fog translator" in system_prompt.casefold():
        return _offline_unscramble_response(user_prompt)
    if "cognitive mirror" in system_prompt.casefold():
        return _offline_realitycheck_response(user_prompt)
    return "I couldn't reach the AI service, but I'm still here. Try again in a moment."


def _try_remote_fallbacks(system_prompt: str, user_prompt: str) -> str:
    for provider in (generate_with_openrouter, generate_with_groq, generate_with_hugging_face):
        try:
            return provider(system_prompt, user_prompt)
        except Exception:
            continue
    return _offline_response(system_prompt, user_prompt)


def generate_text(system_prompt: str, user_prompt: str, history: list[ChatTurn] | None = None) -> str:
    user_payload = _build_history_context(history) + user_prompt
    try:
        return generate_with_google(system_prompt, user_payload)
    except Exception:
        return _try_remote_fallbacks(system_prompt, user_payload)


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
