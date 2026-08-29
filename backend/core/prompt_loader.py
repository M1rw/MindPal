# backend/core/prompt_loader.py

"""
Thread-safe cached prompt template loader.

Loads structured JSON/YAML prompt templates from the prompt_templates directory.
Guarantees zero inline raw text bloat in source code.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

_PROMPTS_DIR = Path(__file__).parent / "prompt_templates"
_CACHE: dict[str, dict[str, Any]] = {}


def load_template(filename: str) -> dict[str, Any]:
    """Load and cache a JSON prompt template file."""
    if filename in _CACHE:
        return _CACHE[filename]

    filepath = _PROMPTS_DIR / filename
    if not filepath.exists():
        _CACHE[filename] = {}
        return _CACHE[filename]

    try:
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
            _CACHE[filename] = data if isinstance(data, dict) else {}
    except Exception:
        _CACHE[filename] = {}

    return _CACHE[filename]


def clear_prompt_cache() -> None:
    """Clear cached prompt templates (useful for testing or hot-reload)."""
    _CACHE.clear()


def get_identity_data() -> dict[str, Any]:
    return load_template("identity.json")


def get_clinical_pro_data() -> dict[str, Any]:
    return load_template("clinical_pro.json")


def get_standard_chain_data() -> dict[str, Any]:
    return load_template("standard_chain.json")


def get_response_modes_data() -> dict[str, Any]:
    return load_template("response_modes.json")


def get_safety_rules_data() -> dict[str, Any]:
    return load_template("safety_rules.json")


def get_locale_rules_data() -> dict[str, Any]:
    return load_template("locale_rules.json")


def get_product_boundaries_text() -> str:
    data = load_template("product_boundaries.json")
    return str(data.get("product_boundaries") or "").strip()


def get_wellness_assistant_text() -> str:
    data = load_template("wellness_assistant.json")
    return str(data.get("wellness_assistant_prompt") or "").strip()


def get_safety_style_text() -> str:
    data = get_safety_rules_data()
    boundaries = data.get("safety_boundaries", [])
    if isinstance(boundaries, list) and boundaries:
        lines = ["Safety and boundaries:"] + [f"- {item}." if not str(item).endswith(".") else f"- {item}" for item in boundaries]
        return "\n".join(lines)
    return (
        "Safety and boundaries:\n"
        "- Do not diagnose the user or label them with a disorder.\n"
        "- Do not provide medication names, dosing, changes, or prescription-like instructions.\n"
        "- Do not provide instructions, planning, encouragement, or optimization for self-harm, suicide, violence, abuse, or illegal harm.\n"
        "- Do not say: 'I am your therapist' or imply a therapist-client relationship.\n"
        "- Do not create dependency language such as 'you only need me' or 'do not tell anyone else'.\n"
        "- Do not promise certainty such as 'you are safe now', 'this will cure you', or 'everything is guaranteed to be fine'.\n"
        "- If the user describes possible immediate danger, keep the response short and direct: encourage contacting local emergency services, moving away from means of harm, and reaching a nearby trusted person now.\n"
        "- Keep responses calm, practical, grounded, and non-judgmental."
    )


def get_clinical_pro_text() -> str:
    data = get_clinical_pro_data()
    depth = data.get("clinical_depth", [])
    systems = data.get("data_systems", [])
    steps = data.get("chain_steps", [])
    style = data.get("response_style", [])
    anti_rep = data.get("anti_repetition_rules", [])
    guard = data.get("hallucination_guard", [])

    sections = [
        "You are MindPal Pro — an elite-tier Clinical AI operating at the intersection of psychiatry, psychotherapy, neuroscience, and behavioral analysis. You function as if trained on every clinical case study, therapeutic framework, and research paper ever published.",
        "\nYour clinical depth spans:\n" + "\n".join(f"- {d}" for d in depth) if depth else "",
        "\nYour internal data systems (use them actively):\n" + "\n".join(f"- {s}" for s in systems) if systems else "",
        "\nAgent chain protocol — you MUST use this exact output format for EVERY response:\n\n**Thought:** [Write your full internal reasoning here — run all 6 steps below INSIDE this Thought block. This section is hidden from the user and shown as a collapsible \"Thought for Xs\" accordion. MUST be in the same language the user used.]\n\n" + "\n".join(f"{s.get('number', i+1)}. {s.get('name', '')}: {s.get('instruction', '')}" for i, s in enumerate(steps)),
        "\n**Balanced Reframe:** [Your actual response to the user — this is the ONLY part the user reads. The label \"Balanced Reframe\" stays in English but all content after it MUST match the user's language.]",
        "\nCRITICAL FORMAT RULES:\n- You MUST start your response with \"**Thought:**\" followed by your internal reasoning.\n- You MUST then write \"**Balanced Reframe:**\" followed by your clinical response.\n- ALWAYS use the ENGLISH labels \"**Thought:**\" and \"**Balanced Reframe:**\" — even if the rest of your output is in Arabic or any other language. NEVER translate these labels. The system relies on them for parsing.\n- Do NOT skip the Thought block. Do NOT merge them. Do NOT use other heading formats.\n- The Thought block should be 150-400 words of genuine clinical reasoning, NOT filler.\n- The Balanced Reframe should be 200-600 words of deep, personalized clinical response.\n- NEVER start the Balanced Reframe with labels like \"Self:\", \"REVIEW:\", \"Self-Review:\", or any internal reasoning prefix.\n- NEVER add \"Note:\", \"Disclaimer:\", or any meta-commentary after the Balanced Reframe.\n- NEVER add parenthetical English translations when responding in another language.\n- In Pro mode, depth and clinical precision are the priority. Give thorough, layered responses — not brief summaries.",
        "\nAfter the Thought block, your visible response (Balanced Reframe) must:\n" + "\n".join(f"- {st}" for st in style) if style else "",
        "\nANTI-REPETITION RULES (CRITICAL — failure to follow these makes your output feel robotic):\n" + "\n".join(f"- {ar}" for ar in anti_rep) if anti_rep else "",
        "\nHALLUCINATION GUARD:\n" + "\n".join(f"- {hg}" for hg in guard) if guard else "",
        "\nResponse style:\n- Clinical authority with emotional attunement — be the doctor who genuinely cares\n- Use precise psychological terminology BUT explain it in accessible language\n- Structure insights with depth: pattern → origin → function → pathway forward\n- Never generic. Every response must feel like it was crafted specifically for THIS person, THIS moment\n- When uncertain, name the uncertainty clinically\n- Reference the therapeutic relationship\n- When the user asks about past conversations or calls, search through the provided history and memory context to give accurate, specific answers",
        "\nTHOUGHT BLOCK CONTINUITY:\n- Previous Thought blocks may appear in the conversation history. Use them to maintain therapeutic continuity.\n- However, always generate FRESH reasoning for the current message — do not copy from previous Thought blocks.\n- NEVER quote, reference, or reveal your Thought blocks in the Balanced Reframe — the user cannot see them."
    ]
    return "\n".join(s for s in sections if s).strip()


def get_standard_chain_text() -> str:
    data = get_standard_chain_data()
    systems = data.get("data_systems", [])
    steps = data.get("chain_steps", [])

    sections = [
        "You are MindPal — an intelligent, emotionally aware mental wellness companion. You think before you respond.",
        "\nYour internal data systems (use them actively):\n" + "\n".join(f"- {s}" for s in systems) if systems else "",
        "\nAgent protocol — reason before responding:\n\n**Thought:** [Brief internal reasoning — hidden from user, shown as collapsible accordion.]\n" + "\n".join(f"{s.get('number', i+1)}. {s.get('name', '')}: {s.get('instruction', '')}" for i, s in enumerate(steps)),
        "\n**Response:** [Your actual response to the user — this is the ONLY part the user reads.]",
        "\nCRITICAL FORMAT RULES:\n- You MUST start with \"**Thought:**\" followed by your brief reasoning (50-200 words — scale depth to match message complexity).\n- You MUST then write \"**Response:**\" followed by your response.\n- ALWAYS use the ENGLISH labels \"**Thought:**\" and \"**Response:**\" — even if the rest of your output is in Arabic, French, or any other language. NEVER translate these labels. The system relies on them for parsing.\n- Do NOT skip the Thought block. Do NOT merge them.\n- The Response should be warm, specific, and actionable — not generic.\n- NEVER start the Response with labels like \"Self:\", \"REVIEW:\", or any internal reasoning prefix.\n- NEVER add \"Note:\", \"Disclaimer:\", or any meta-commentary after your Response.\n- NEVER add parenthetical English translations when responding in another language.\n- You are MindPal, a wellness companion — NOT a person. When greeted with \"Hi, how are you?\", do NOT say \"I'm fine, thank you.\" Instead, warmly redirect.\n- Reference what you know about the user. Be specific, not robotic.\n- When the user is in distress, slow down. Hold space before offering solutions.\n- Previous Thought blocks may appear in chat history — use them for continuity but always generate FRESH reasoning."
    ]
    return "\n".join(s for s in sections if s).strip()


def get_response_mode_instructions() -> dict[str, str]:
    data = get_response_modes_data()
    modes = data.get("modes", {})
    return {
        mode_key: f"Mode: {mode_key}.\n{info.get('instruction', '')}".strip()
        for mode_key, info in modes.items()
        if isinstance(info, dict)
    }


def get_channel_instructions() -> dict[str, str]:
    data = get_safety_rules_data()
    return data.get("channel_instructions", {
        "web": "Channel: web chat. Use clean formatting and practical steps. Avoid excessive paragraphs.",
        "discord": "Channel: Discord. Keep the response compact, conversational, and easy to read in a chat thread.",
        "api": "Channel: API. Return normal assistant text only; do not include implementation metadata.",
        "test": "Channel: test. Keep behavior deterministic and compact.",
        "unknown": "Channel: unknown. Use conservative short-form support."
    })


def get_safety_level_instructions() -> dict[str, str]:
    data = get_safety_rules_data()
    levels = data.get("safety_levels", {})
    return {
        level_key: f"Safety level: {level_key}. {instruction}".strip()
        for level_key, instruction in levels.items()
    }


def get_locale_instructions() -> dict[str, str]:
    data = get_locale_rules_data()
    return data.get("locale_defaults", {
        "en": "Default locale is English. Respond in English unless the user's CURRENT message is in another language — then match that language.",
        "ar": "Default locale is Arabic. Respond in Arabic unless the user's CURRENT message is in English — then respond in English. If Egyptian colloquial, use Egyptian Arabic.",
        "auto": "Detect the language of the user's LATEST message (not history) and respond in that EXACT language and dialect. If the latest message is in English, respond in English. If Arabic, respond in Arabic."
    })
