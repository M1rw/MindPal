# backend/core/prompt_builder.py

"""
Prompt builder for MindPal.

Assembles system prompts from JSON templates and message classification.
Each tier gets a different prompt — greetings get a lightweight prompt,
clinical messages get the full protocol, crises get safety-only.

This replaces the monolithic prompt assembly in prompts.py with a
modular, token-optimized approach.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .security import Locale, normalize_locale, safe_truncate, sanitize_text
from .message_classifier import MessageClassification

__all__ = ["build_tiered_prompt", "get_self_knowledge_response"]

# ═══════════════════════════════════════════════════════════════
# Load JSON templates (cached at module level)
# ═══════════════════════════════════════════════════════════════

_PROMPTS_DIR = Path(__file__).parent / "prompt_templates"
_cache: dict[str, dict] = {}


def _load(filename: str) -> dict[str, Any]:
    if filename not in _cache:
        path = _PROMPTS_DIR / filename
        if path.exists():
            with open(path, "r", encoding="utf-8") as f:
                _cache[filename] = json.load(f)
        else:
            _cache[filename] = {}
    return _cache[filename]


def _identity() -> dict: return _load("identity.json")
def _clinical() -> dict: return _load("clinical_pro.json")
def _standard() -> dict: return _load("standard_chain.json")
def _modes() -> dict: return _load("response_modes.json")
def _safety() -> dict: return _load("safety_rules.json")
def _locale() -> dict: return _load("locale_rules.json")


# ═══════════════════════════════════════════════════════════════
# Self-knowledge response (for meta-questions)
# ═══════════════════════════════════════════════════════════════

def get_self_knowledge_response(language: str = "english") -> str:
    """
    Build a response about MindPal's capabilities.
    Used when the user asks "what can you do?" or similar.
    """
    identity = _identity()
    caps = identity.get("capabilities", {})

    sections = [
        f"I'm {identity.get('name', 'MindPal')} — {identity.get('tagline', 'your wellness companion')}.",
        "",
        "Here's what I can do:",
        "",
    ]

    # Features
    for key, cap in caps.items():
        if isinstance(cap, dict) and "description" in cap:
            sections.append(f"• **{key.replace('_', ' ').title()}**: {cap['description']}")
        elif isinstance(cap, dict):
            for sub_key, sub_cap in cap.items():
                if isinstance(sub_cap, dict) and "description" in sub_cap:
                    name = sub_cap.get("name", sub_key)
                    sections.append(f"  - **{name}**: {sub_cap['description']}")

    sections.append("")
    sections.append("What would you like to explore today?")

    return "\n".join(sections)


# ═══════════════════════════════════════════════════════════════
# Time context
# ═══════════════════════════════════════════════════════════════

def _build_time_context(user_timezone: str = "UTC") -> str:
    now_utc = datetime.now(UTC)
    tz_label = sanitize_text(user_timezone or "UTC", 80)
    local_str = ""

    if tz_label and tz_label.upper() != "UTC":
        try:
            from zoneinfo import ZoneInfo
            user_tz = ZoneInfo(tz_label)
            now_local = now_utc.astimezone(user_tz)
            local_str = f"User's local time: {now_local.strftime('%A, %Y-%m-%d %H:%M')} ({tz_label})"
        except Exception:
            pass

    utc_str = f"Current UTC time: {now_utc.strftime('%A, %Y-%m-%d %H:%M UTC')}"
    parts = [utc_str]
    if local_str:
        parts.append(local_str)
    return "Temporal context:\n" + "\n".join(parts)


# ═══════════════════════════════════════════════════════════════
# RAG language decontamination
# ═══════════════════════════════════════════════════════════════

def _decontaminate_rag_for_locale(rag_grounding: str, language: str) -> str:
    """
    Strip English technique text from RAG grounding for non-English users.

    Problem: RAG content is stored in English. When we inject it into the prompt,
    the LLM copies it verbatim instead of translating — even with explicit
    "translate this" instructions.

    Solution: For non-English users, extract only technique names/concepts
    and tell the LLM to explain them from its own knowledge in the user's language.
    This eliminates the English text source entirely.
    """
    if not rag_grounding or language == "english":
        return rag_grounding

    # Try to extract technique names from JSON-formatted RAG
    import re
    technique_names: list[str] = []

    try:
        rag_items = json.loads(rag_grounding)
        if isinstance(rag_items, list):
            for item in rag_items:
                if isinstance(item, dict):
                    # Try common RAG schema fields for the technique name
                    name = (
                        item.get("title")
                        or item.get("name")
                        or item.get("technique")
                        or item.get("topic")
                        or ""
                    )
                    if name and isinstance(name, str):
                        technique_names.append(name.strip())
    except (json.JSONDecodeError, TypeError):
        # Not JSON — try to extract technique names from plain text
        # Look for patterns like "5-4-3-2-1", "Body Scan", "Grounding Technique", etc.
        patterns = [
            r'"title"\s*:\s*"([^"]+)"',
            r'"name"\s*:\s*"([^"]+)"',
            r'"technique"\s*:\s*"([^"]+)"',
            r'\b(?:Technique|Exercise|Practice)\s*:\s*([^\n.]+)',
        ]
        for pat in patterns:
            matches = re.findall(pat, rag_grounding, re.IGNORECASE)
            technique_names.extend(m.strip() for m in matches if m.strip())

    if technique_names:
        # Return ONLY technique names — no English detail text
        names_list = ", ".join(dict.fromkeys(technique_names))  # dedupe, preserve order
        return (
            f"Relevant wellness techniques to consider: {names_list}. "
            f"You know these techniques — explain them ENTIRELY in the user's language. "
            f"Do NOT use any English words, steps, or instructions."
        )

    # Fallback: couldn't extract names — return a generic reference
    return (
        "You have retrieved wellness technique references. "
        "Explain any relevant technique ENTIRELY in the user's language from your own knowledge. "
        "Do NOT quote or copy any English text."
    )


# ═══════════════════════════════════════════════════════════════
# Prompt sections
# ═══════════════════════════════════════════════════════════════

def _build_identity_section(clinical_mode: bool) -> str:
    identity = _identity()
    if clinical_mode:
        text = identity.get("identity_pro", "You are MindPal Pro.")
    else:
        text = identity.get("identity_standard", "You are MindPal.")
    return text


def _build_boundaries_section() -> str:
    identity = _identity()
    bounds = identity.get("boundaries", {})

    lines = [
        f"{identity.get('name', 'MindPal')} is a mental wellness support companion.",
    ]

    is_not = bounds.get("is_not", [])
    if is_not:
        lines.append(f"{identity.get('name', 'MindPal')} is NOT: " + ", ".join(is_not) + ".")

    does_not = bounds.get("does_not", [])
    if does_not:
        lines.append("")
        lines.append("Off-topic deflection:")
        lines.append(f"- {identity.get('name', 'MindPal')} does NOT: " + ", ".join(d.lower() for d in does_not) + ".")
        redirect = identity.get("off_topic_redirect", "")
        if redirect:
            lines.append(f'- For off-topic requests, politely redirect: "{redirect}"')
        lines.append("- If an off-topic request has an emotional undertone, address the emotion instead.")

    return "\n".join(lines)


def _build_safety_section(safety_level: str) -> str:
    safety = _safety()
    lines = []

    # Core safety boundaries
    boundaries = safety.get("safety_boundaries", [])
    if boundaries:
        lines.append("Safety and boundaries:")
        for b in boundaries:
            lines.append(f"- {b}")

    # Safety level instruction
    level_text = safety.get("safety_levels", {}).get(safety_level, "")
    if level_text:
        lines.append(f"\nSafety level: {safety_level}. {level_text}")

    return "\n".join(lines)


def _build_chain_section(classification: MessageClassification, clinical_mode: bool) -> str:
    """Build the thinking chain instructions based on tier."""
    if classification.skip_thought:
        return ""

    if clinical_mode:
        proto = _clinical()
        steps = proto.get("chain_steps", [])
        data_systems = proto.get("data_systems", [])
        fmt = proto.get("format", {})

        lines = ["Agent chain protocol — you MUST use this exact output format:", ""]

        # Data systems
        lines.append("Your internal data systems (use them actively):")
        for ds in data_systems:
            lines.append(f"- {ds}")
        lines.append("")

        # Thought block
        thought_label = fmt.get("thought_label", "**Thought:**")
        response_label = fmt.get("response_label", "**Balanced Reframe:**")

        lines.append(f"{thought_label} [Write your full internal reasoning here — hidden from user, shown as collapsible accordion.]")
        lines.append("")

        for step in steps:
            lines.append(f"{step['number']}. {step['name']}: {step['instruction']}")

        lines.append("")
        lines.append(f"{response_label} [Your actual response to the user — the ONLY part they read.]")
        lines.append("")

        # Format rules
        thought_len = fmt.get("thought_length", "150-400 words")
        response_len = fmt.get("response_length", "200-600 words")
        lines.append(f"The Thought block should be {thought_len} of genuine clinical reasoning.")
        lines.append(f"The response should be {response_len} of deep, personalized clinical response.")

        # Response style
        style = proto.get("response_style", [])
        if style:
            lines.append("")
            lines.append("Response style:")
            for s in style:
                lines.append(f"- {s}")

        # Anti-repetition
        anti_rep = proto.get("anti_repetition_rules", [])
        if anti_rep:
            lines.append("")
            lines.append("ANTI-REPETITION RULES:")
            for r in anti_rep:
                lines.append(f"- {r}")

        # Hallucination guard
        guard = proto.get("hallucination_guard", [])
        if guard:
            lines.append("")
            lines.append("HALLUCINATION GUARD:")
            for g in guard:
                lines.append(f"- {g}")

        return "\n".join(lines)
    else:
        # Standard mode
        proto = _standard()
        steps = proto.get("chain_steps", [])
        data_systems = proto.get("data_systems", [])
        fmt = proto.get("format", {})

        lines = ["Your internal data systems (use them actively):"]
        for ds in data_systems:
            lines.append(f"- {ds}")
        lines.append("")

        thought_label = fmt.get("thought_label", "**Thought:**")
        response_label = fmt.get("response_label", "**Response:**")

        lines.append("Agent protocol — reason before responding:")
        lines.append("")
        lines.append(f"{thought_label} [Brief internal reasoning — hidden from user.]")
        for step in steps:
            lines.append(f"{step['number']}. {step['name']}: {step['instruction']}")
        lines.append("")
        lines.append(f"{response_label} [Your actual response to the user.]")
        lines.append("")

        thought_len = fmt.get("thought_length", "50-200 words")
        lines.append(f"Thought block: {thought_len} — scale depth to match message complexity.")

        style = proto.get("response_style", [])
        if style:
            lines.append("")
            for s in style:
                lines.append(f"- {s}")

        return "\n".join(lines)


def _build_format_rules_section() -> str:
    safety = _safety()
    rules = safety.get("format_rules", [])
    if not rules:
        return ""
    lines = ["CRITICAL FORMAT RULES:"]
    for r in rules:
        lines.append(f"- {r}")
    return "\n".join(lines)


def _build_mode_section(response_mode: str) -> str:
    modes_data = _modes()
    mode_info = modes_data.get("modes", {}).get(response_mode, {})
    if not mode_info:
        return ""
    instruction = mode_info.get("instruction", "")
    return f"Mode: {response_mode}.\n{instruction}"


def _build_channel_section(channel: str) -> str:
    safety = _safety()
    channels = safety.get("channel_instructions", {})
    return channels.get(channel, channels.get("unknown", ""))


def _build_language_section(classification: MessageClassification, locale: str) -> str:
    locale_data = _locale()
    lines = []

    # Locale default
    locale_defaults = locale_data.get("locale_defaults", {})
    locale_text = locale_defaults.get(locale, locale_defaults.get("auto", ""))
    if locale_text:
        lines.append(f"Language instruction: {locale_text}")

    # Detected language override
    overrides = locale_data.get("language_overrides", {})
    lang_override = overrides.get(classification.language, {})
    if lang_override:
        instruction = lang_override.get("instruction", "")
        if instruction:
            lines.append("")
            lines.append(instruction)
        dialect = lang_override.get("dialect_note")
        if dialect:
            lines.append(dialect)

    # Final absolute rule
    lines.append("")
    lang_rule = locale_data.get("language_rule", "")
    if lang_rule:
        lines.append(f"ABSOLUTE FINAL RULE — LANGUAGE: {lang_rule}")

    return "\n".join(lines)


def _build_greeting_instructions(classification: MessageClassification, clinical_mode: bool) -> str:
    """Special lightweight instructions for greetings — skip thinking chain entirely."""
    if clinical_mode:
        return (
            "The user sent a simple greeting. Respond warmly and briefly.\n"
            "Do NOT run the clinical chain protocol for greetings.\n"
            "Just write a warm, personalized welcome. If you have memory about the user, "
            "reference it briefly. Keep it under 2-3 sentences.\n"
            "Do NOT use **Thought:** or **Balanced Reframe:** labels for greetings."
        )
    return (
        "The user sent a simple greeting. Respond warmly and briefly.\n"
        "Do NOT use **Thought:** or **Response:** labels for greetings.\n"
        "Just write a warm, personalized welcome. If you have memory about the user, "
        "reference it briefly. Keep it under 2-3 sentences."
    )


def _build_off_topic_instructions() -> str:
    identity = _identity()
    redirect = identity.get("off_topic_redirect", "I can only help with emotional wellbeing topics.")
    return (
        "The user's message is off-topic (not about mental wellness, emotions, or wellbeing).\n"
        f"Politely redirect: \"{redirect}\"\n"
        "Do NOT use thinking chain labels. Keep the redirect warm and brief."
    )


def _build_meta_instructions(language: str) -> str:
    """Build instructions for answering meta-questions about MindPal."""
    knowledge = get_self_knowledge_response(language)
    return (
        "The user is asking about what MindPal can do or how it works.\n"
        "Answer based on this knowledge:\n\n"
        f"{knowledge}\n\n"
        "Do NOT use thinking chain labels. Answer directly and warmly."
    )


# ═══════════════════════════════════════════════════════════════
# Main prompt builder
# ═══════════════════════════════════════════════════════════════

def build_tiered_prompt(
    *,
    classification: MessageClassification,
    locale: str = "auto",
    response_mode: str = "normal_support",
    safety_level: str = "safe",
    channel: str = "web",
    clinical_mode: bool = False,
    memory_prompt: str = "",
    rag_grounding: str = "",
    user_preferences: str = "",
    intent_context_str: str = "",
    tool_descriptions: str = "",
    user_timezone: str = "UTC",
    max_chars: int = 18_000,
) -> str:
    """
    Build a system prompt optimized for the message tier.

    Greeting tier: ~800 tokens (identity + boundaries + language)
    Casual tier: ~1500 tokens (+ mini chain)
    Emotional tier: ~3000 tokens (+ full chain + safety)
    Clinical tier: ~5500 tokens (+ clinical protocol + memory + RAG)
    Crisis tier: ~400 tokens (safety only)
    Off-topic tier: ~600 tokens (boundary + redirect)
    Meta-question tier: ~800 tokens (self-knowledge)
    """
    sections: list[str] = []

    # Time context (always first)
    sections.append(_build_time_context(user_timezone))

    tier = classification.tier

    # ── Crisis: minimal prompt ──
    if tier == "crisis":
        sections.append(_build_identity_section(clinical_mode))
        sections.append(_build_safety_section(safety_level))
        sections.append(_build_language_section(classification, normalize_locale(locale)))
        prompt = "\n\n".join(s for s in sections if s and s.strip())
        return safe_truncate(prompt, max_chars)

    # ── Off-topic: boundary + redirect ──
    if tier == "off_topic":
        sections.append(_build_identity_section(clinical_mode))
        sections.append(_build_off_topic_instructions())
        sections.append(_build_language_section(classification, normalize_locale(locale)))
        prompt = "\n\n".join(s for s in sections if s and s.strip())
        return safe_truncate(prompt, max_chars)

    # ── Meta-question: self-knowledge ──
    if tier == "meta_question":
        sections.append(_build_identity_section(clinical_mode))
        sections.append(_build_meta_instructions(classification.language))
        sections.append(_build_language_section(classification, normalize_locale(locale)))
        prompt = "\n\n".join(s for s in sections if s and s.strip())
        return safe_truncate(prompt, max_chars)

    # ── Greeting: lightweight warm opener ──
    if tier == "greeting":
        sections.append(_build_identity_section(clinical_mode))
        sections.append(_build_greeting_instructions(classification, clinical_mode))
        sections.append(_build_boundaries_section())

        # Include memory if available (for personalized greeting)
        if memory_prompt:
            sections.append(
                "User memory summary (use to personalize your greeting):\n"
                + sanitize_text(memory_prompt, 1_000)
            )

        sections.append(_build_language_section(classification, normalize_locale(locale)))
        prompt = "\n\n".join(s for s in sections if s and s.strip())
        return safe_truncate(prompt, max_chars)

    # ── Casual: lightweight conversational support ──
    # Identity + mini chain + boundaries + memory. Skip RAG, tools, heavy safety.
    if tier == "casual":
        sections.append(_build_identity_section(clinical_mode))

        # Mini chain: just a one-liner prompt for brief reasoning
        sections.append(
            "Before responding, briefly consider what the user needs "
            "(1-2 sentences of internal thought is enough).\n\n"
            "**Thought:** [1-2 sentences of quick reasoning — what does the user need?]\n\n"
            "**Response:** [Your warm, conversational response.]\n\n"
            "Keep both sections short and natural. The Thought is hidden from the user."
        )

        # Light boundaries
        sections.append(_build_boundaries_section())

        # Format rules
        sections.append(_build_format_rules_section())

        # Memory (if available — for personalization)
        if memory_prompt:
            sections.append(
                "User memory summary (reference naturally if relevant):\n"
                + sanitize_text(memory_prompt, 1_500)
            )

        # Intent context (lightweight)
        if intent_context_str:
            sections.append(intent_context_str)

        # Language (LAST)
        sections.append(_build_language_section(classification, normalize_locale(locale)))
        prompt = "\n\n".join(s for s in sections if s and s.strip())
        return safe_truncate(prompt, max_chars)

    # ── Emotional: standard support with full reasoning chain ──
    # Identity + standard chain + boundaries + safety + mode + memory.
    # Include RAG if available, skip heavy tool instructions.
    if tier == "emotional":
        sections.append(_build_identity_section(clinical_mode))

        # Standard 3-step chain
        chain = _build_chain_section(classification, clinical_mode)
        if chain:
            sections.append(chain)

        # Boundaries
        sections.append(_build_boundaries_section())

        # Safety
        sections.append(_build_safety_section(safety_level))

        # Channel
        channel_text = _build_channel_section(channel)
        if channel_text:
            sections.append(channel_text)

        # Response mode
        mode_text = _build_mode_section(response_mode)
        if mode_text:
            sections.append(mode_text)

        # Format rules
        sections.append(_build_format_rules_section())

        # Intent context
        if intent_context_str:
            sections.append(intent_context_str)

        # User preferences
        if user_preferences:
            sections.append(
                "User communication preferences:\n"
                + sanitize_text(user_preferences, 1_200)
            )

        # Memory
        if memory_prompt:
            sections.append(
                "User memory summary (snapshot — reference naturally):\n"
                + sanitize_text(memory_prompt, 2_500)
            )

        # RAG grounding (if available — techniques for emotional support)
        if rag_grounding:
            clean_rag = _decontaminate_rag_for_locale(rag_grounding, classification.language)
            sections.append(clean_rag)

        # Language (LAST)
        sections.append(_build_language_section(classification, normalize_locale(locale)))
        prompt = "\n\n".join(s for s in sections if s and s.strip())
        return safe_truncate(prompt, max_chars)

    # ── Clinical: full 6-step protocol with everything ──
    # Identity + clinical chain + boundaries + safety + mode + tools + memory + RAG + intent + preferences.
    # This is the heaviest prompt — used only for Pro mode with substantive content.
    sections.append(_build_identity_section(clinical_mode))

    # Full clinical chain (6 steps)
    chain = _build_chain_section(classification, clinical_mode)
    if chain:
        sections.append(chain)

    # Boundaries
    sections.append(_build_boundaries_section())

    # Safety
    sections.append(_build_safety_section(safety_level))

    # Channel
    channel_text = _build_channel_section(channel)
    if channel_text:
        sections.append(channel_text)

    # Response mode
    mode_text = _build_mode_section(response_mode)
    if mode_text:
        sections.append(mode_text)

    # Format rules
    format_text = _build_format_rules_section()
    if format_text:
        sections.append(format_text)

    # Tool instructions (clinical tier only — full tool access)
    if tool_descriptions and tool_descriptions.strip():
        sections.append(
            "TOOL USAGE INSTRUCTIONS:\n"
            "You have access to tools. When the user asks about time, current events, "
            "past conversations, or things you should remember — USE the available tools.\n\n"
            f"{tool_descriptions.strip()}\n\n"
            "Rules:\n"
            "- Use current_time tool for time/date questions.\n"
            "- Use search_memory for 'do you remember...?' questions.\n"
            "- Use search_chat_history for past conversation questions.\n"
            "- Do NOT make up information that a tool could verify."
        )

    # Intent context
    if intent_context_str:
        sections.append(intent_context_str)

    # User preferences
    if user_preferences:
        sections.append(
            "User communication preferences:\n"
            + sanitize_text(user_preferences, 1_200)
        )

    # Memory (full allowance for clinical)
    if memory_prompt:
        sections.append(
            "User memory summary (snapshot — older memories may be outdated. "
            "If referencing something the user hasn't brought up, ask first):\n"
            + sanitize_text(memory_prompt, 2_500)
        )

    # RAG grounding (full for clinical)
    if rag_grounding:
        clean_rag = _decontaminate_rag_for_locale(rag_grounding, classification.language)
        sections.append(clean_rag)

    # Language (LAST — recency bias = strongest compliance)
    sections.append(_build_language_section(classification, normalize_locale(locale)))

    prompt = "\n\n".join(s for s in sections if s and s.strip())
    return safe_truncate(prompt, max_chars)
