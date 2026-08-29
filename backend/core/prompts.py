# backend/core/prompts.py

"""
Prompt templates, intent analysis, and response mode inference for MindPal.

This module provides:
- Externalized prompt template accessors (loaded from JSON/YAML via prompt_loader)
- Standard and Pro mode agent chain instructions
- Tool-use and temporal context generation
- Semantic intent analysis (build_intent_context)
- Response mode inference and policy assembly (build_system_prompt, render_system_prompt)
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .prompt_loader import (
    get_channel_instructions,
    get_clinical_pro_text,
    get_locale_instructions,
    get_product_boundaries_text,
    get_response_mode_instructions,
    get_response_modes_data,
    get_safety_level_instructions,
    get_safety_rules_data,
    get_safety_style_text,
    get_standard_chain_text,
    get_wellness_assistant_text,
)
from .security import Locale, normalize_locale, safe_truncate, sanitize_text

# Prompt constants dynamically loaded from external templates
PRODUCT_BOUNDARY_PROMPT = get_product_boundaries_text()
CLINICAL_PRO_PROMPT = get_clinical_pro_text()
SAFETY_STYLE_PROMPT = get_safety_style_text()
WELLNESS_ASSISTANT_PROMPT = get_wellness_assistant_text()
STANDARD_AGENT_CHAIN_PROMPT = get_standard_chain_text()

ResponseMode = Literal[
    "normal_support",
    "panic_grounding",
    "ambiguous_self_harm_support",
    "personal_safety",
    "anger_deescalation",
    "study_stress",
    "relationship_distress",
    "emotion_labeling",
    "memory_compaction",
    "rag_planning",
    "safe_rewrite",
]

Channel = Literal["web", "discord", "api", "test", "unknown"]

MAX_MEMORY_PROMPT_CHARS = 2_500
MAX_RAG_ITEMS = 6
MAX_RAG_ITEM_CHARS = 1_200
MAX_USER_PREFERENCES_CHARS = 1_200
MAX_SYSTEM_PROMPT_CHARS = 18_000
MAX_INTENT_CONTEXT_CHARS = 1_800

# Routing and mode sets loaded from response_modes.json
_modes_data = get_response_modes_data()
ALLOWED_RESPONSE_MODES: set[str] = set(_modes_data.get("allowed_chat_modes", [
    "normal_support", "panic_grounding", "ambiguous_self_harm_support",
    "personal_safety", "anger_deescalation", "study_stress",
    "relationship_distress", "emotion_labeling"
]))

SAFETY_OVERRIDE_MODES: set[str] = set(_modes_data.get("safety_override_modes", [
    "ambiguous_self_harm_support", "personal_safety"
]))

PREFERENCE_MODE_FAMILIES: dict[str, set[str]] = {
    family: set(modes)
    for family, modes in _modes_data.get("preference_families", {
        "active_listen": ["normal_support", "emotion_labeling", "relationship_distress", "panic_grounding"],
        "guided_coach": ["relationship_distress", "anger_deescalation", "study_stress", "normal_support"],
        "cognitive_tools": ["emotion_labeling", "relationship_distress", "study_stress", "anger_deescalation"],
    }).items()
}

VALID_RAG_TAGS: tuple[str, ...] = (
    "panic_grounding", "grounding_54321", "box_breathing", "orienting_to_room",
    "anxiety", "anger", "impulse", "dbt_stop", "study_stress", "exam_anxiety",
    "relationship", "relationship_distress", "grief", "emotion_labeling",
    "cognitive_reframe", "safety", "self_harm", "abuse_or_violence", "sleep",
    "breathing", "journaling"
)

_EGYPTIAN_ARABIC_MARKERS = (
    "ازاي", "عايز", "عايزة", "مش", "مليش", "حاسس", "حاسه", "بحس", "خبت",
    "بيقلل", "بيتحكم", "جوزي", "مراتي", "كفاية", "تعبت", "اقول", "أقول"
)
_PANIC_MARKERS = (
    "panic", "panicking", "panic attack", "can't breathe", "cant breathe", "chest tight",
    "heart racing", "هلع", "نوبة هلع", "مش قادر اتنفس", "مش قادرة اتنفس",
    "ضيق نفس", "قلبي بيدق", "صدري", "رعشة", "بتخنق"
)
_ANGER_MARKERS = (
    "angry", "rage", "furious", "revenge", "text her now", "text him now", "hurt him",
    "hurt her", "break something", "غضبان", "متعصب", "هتجنن", "انتقم", "أنتقم",
    "اكسر", "اضرب", "هكلمه دلوقتي", "هكلمها دلوقتي"
)
_STUDY_MARKERS = (
    "exam", "quiz", "study", "studying", "homework", "assignment", "lecture", "sheet",
    "امتحان", "كويز", "مذاكرة", "اذاكر", "أذاكر", "محاضرة", "شيت", "واجب"
)
_RELATIONSHIP_MARKERS = (
    "girlfriend", "boyfriend", "relationship", "wife", "husband", "marriage", "partner",
    "break up", "divorce", "حبيبتي", "حبيبي", "صاحبتي", "صاحبي", "جوزي", "زوجي",
    "مراتي", "زوجتي", "جواز", "بعد الجواز", "انفصل", "أطلق", "طلاق", "مي"
)
_RELATIONSHIP_INVALIDATION_MARKERS = (
    "criticize", "criticizes", "criticism", "worthless", "no value", "weak", "controlling",
    "humiliate", "jealous of my success", "20 years", "continue or leave", "ينتقدني",
    "بينتقدني", "ينتقد", "مش عاجبه", "مش عاجبه أي حاجة", "مليش قيمة", "مالييش قيمة",
    "ضعيفة", "ضعيف", "بيقلل مني", "بيقلل", "تقليل", "يهزقني", "يذلني", "بيغير من نجاحي",
    "بيغير", "بعد 20 سنة", "أكمل", "اكمل", "كفاية", "تعبت منه", "فين الحب"
)
_RELATIONSHIP_DANGER_MARKERS = (
    "won't let me leave", "wont let me leave", "threatened me", "threatens me", "hit me",
    "hits me", "afraid of him", "afraid of her", "unsafe", "trapped", "يهددني",
    "هددني", "بيضربني", "ضربني", "خايفة منه", "خايف منه", "مش سايبني أخرج",
    "مش سايباني أخرج", "مانعني", "حبسني", "مش آمنة", "مش امنة", "خطر"
)
_GRIEF_MARKERS = ("died", "death", "lost someone", "grief", "مات", "ماتت", "وفاة", "توفى", "فقدت")
_SELF_HARM_MARKERS = (
    "hurt myself", "kill myself", "suicide", "end my life", "مش عايز اعيش", "مش عايزة اعيش",
    "أموت نفسي", "انتحر", "هأذي نفسي", "هاذي نفسي"
)
_SPANISH_MARKERS = (
    "hola", "buenos días", "buenas noches", "cómo estás", "como estas", "estoy mal",
    "me siento", "ayuda", "gracias", "adiós", "lo siento", "triste", "solo", "sola"
)
_FRENCH_MARKERS = (
    "bonjour", "salut", "ça va", "ca va", "je me sens", "aide", "merci", "au revoir",
    "désolé", "desole", "triste", "seul", "seule"
)


@dataclass(frozen=True, slots=True)
class PromptPolicy:
    locale: Locale = "auto"
    response_mode: ResponseMode = "normal_support"
    safety_level: str = "safe"
    channel: Channel = "web"
    memory_summary: str | None = None
    rag_grounding: tuple[dict[str, Any], ...] = ()
    user_preferences: str | None = None
    intent_context: dict[str, Any] | None = None
    clinical_mode: bool = False
    tool_descriptions: str = ""
    user_timezone: str = "UTC"
    max_chars: int = MAX_SYSTEM_PROMPT_CHARS


def build_prompt_policy(
    *,
    locale: str = "auto",
    response_mode: ResponseMode = "normal_support",
    safety_level: str = "safe",
    channel: str = "web",
    memory_summary: str | None = None,
    rag_grounding: list[dict[str, Any]] | tuple[dict[str, Any], ...] | None = None,
    user_preferences: str | None = None,
    intent_context: dict[str, Any] | None = None,
    clinical_mode: bool = False,
    tool_descriptions: str = "",
    user_timezone: str = "UTC",
    max_chars: int = MAX_SYSTEM_PROMPT_CHARS,
) -> PromptPolicy:
    return PromptPolicy(
        locale=normalize_locale(locale),
        response_mode=_normalize_response_mode(response_mode),
        safety_level=_normalize_safety_level(safety_level),
        channel=_normalize_channel(channel),
        memory_summary=memory_summary,
        rag_grounding=tuple(rag_grounding or ()),
        user_preferences=user_preferences,
        intent_context=intent_context,
        clinical_mode=clinical_mode,
        tool_descriptions=tool_descriptions or "",
        user_timezone=sanitize_text(user_timezone or "UTC", 80),
        max_chars=max(1, min(int(max_chars), MAX_SYSTEM_PROMPT_CHARS)),
    )


def build_system_prompt(
    memory_summary: str | None,
    rag_grounding: list[dict[str, Any]] | None,
    locale: str = "auto",
    *,
    response_mode: ResponseMode = "normal_support",
    safety_level: str = "safe",
    channel: str = "web",
    user_preferences: str | None = None,
    intent_context: dict[str, Any] | None = None,
    clinical_mode: bool = False,
    tool_descriptions: str = "",
    user_timezone: str = "UTC",
    max_chars: int = MAX_SYSTEM_PROMPT_CHARS,
) -> str:
    policy = build_prompt_policy(
        locale=locale,
        response_mode=response_mode,
        safety_level=safety_level,
        channel=channel,
        memory_summary=memory_summary,
        rag_grounding=rag_grounding,
        user_preferences=user_preferences,
        intent_context=intent_context,
        clinical_mode=clinical_mode,
        tool_descriptions=tool_descriptions,
        user_timezone=user_timezone,
        max_chars=max_chars,
    )
    return render_system_prompt(policy)


def render_system_prompt(policy: PromptPolicy) -> str:
    time_context = build_time_context(policy.user_timezone)
    channel_instr = get_channel_instructions().get(policy.channel, "Channel: web chat.")
    safety_instr = get_safety_level_instructions().get(policy.safety_level, "Safety level: safe.")
    mode_instr = get_response_mode_instructions().get(policy.response_mode, "Mode: normal_support.")

    if policy.clinical_mode:
        sections = [time_context, CLINICAL_PRO_PROMPT, PRODUCT_BOUNDARY_PROMPT, SAFETY_STYLE_PROMPT, channel_instr, safety_instr, mode_instr]
    else:
        sections = [time_context, STANDARD_AGENT_CHAIN_PROMPT, PRODUCT_BOUNDARY_PROMPT, SAFETY_STYLE_PROMPT, WELLNESS_ASSISTANT_PROMPT, channel_instr, safety_instr, mode_instr]

    if policy.tool_descriptions:
        sections.append(build_tool_instructions(policy.tool_descriptions))
    if policy.intent_context and (rendered_intent := _render_intent_context(policy.intent_context)):
        sections.append(rendered_intent)
    if policy.user_preferences and (rendered_prefs := _render_user_preferences(policy.user_preferences)):
        sections.append(rendered_prefs)
    if policy.memory_summary and (rendered_mem := _render_memory(policy.memory_summary)):
        sections.append(rendered_mem)
    if policy.rag_grounding and (rendered_rag := _render_rag_grounding(list(policy.rag_grounding))):
        sections.append(rendered_rag)

    locale_instr_map = get_locale_instructions()
    locale_line = f"Language instruction: {locale_instr_map.get(policy.locale, locale_instr_map.get('auto', ''))}"
    detected_lang = _resolve_detected_language_block(policy.intent_context)

    final_block = f"{locale_line}\n\n{detected_lang}\n\n" if detected_lang else f"{locale_line}\n\n"
    final_block += (
        "ABSOLUTE FINAL RULE — LANGUAGE: Look at the user's LATEST message. Respond ENTIRELY in THAT language.\n"
        "- If English → entire output in English.\n"
        "- If Arabic → entire output in Arabic (including all techniques).\n"
        "- If Egyptian Arabic → use Egyptian dialect for everything.\n"
        "- NEVER mix languages.\n"
    )
    if policy.clinical_mode:
        final_block += (
            "GREETING SHORTCUT: For simple greetings, keep **Thought:** under 50 words.\n"
            "Final instruction: Execute full clinical protocol and deliver **Balanced Reframe:**."
        )
    else:
        final_block += "Final instruction: Answer as MindPal with supportive wellness guidance only."

    sections.append(final_block)
    prompt = "\n\n".join(section for section in sections if section and section.strip())
    return safe_truncate(prompt, policy.max_chars)


def build_time_context(user_timezone: str = "UTC") -> str:
    now_utc = datetime.now(UTC)
    local_str = ""
    tz_label = sanitize_text(user_timezone or "UTC", 80)
    if tz_label and tz_label.upper() != "UTC":
        try:
            now_local = now_utc.astimezone(ZoneInfo(tz_label))
            local_str = f"User's local time: {now_local.strftime('%A, %Y-%m-%d %H:%M')} ({tz_label})"
        except (ZoneInfoNotFoundError, ValueError):
            pass
    parts = [f"Current UTC time: {now_utc.strftime('%A, %Y-%m-%d %H:%M UTC')}"]
    if local_str:
        parts.append(local_str)
    return "Temporal context:\n" + "\n".join(parts)


def build_tool_instructions(tool_descriptions: str) -> str:
    if not tool_descriptions or not tool_descriptions.strip():
        return ""
    return (
        "TOOL USAGE INSTRUCTIONS:\nYou have access to tools. When the user asks about time, events, "
        "or facts — USE available tools.\n\n"
        f"{tool_descriptions.strip()}\n\n"
        "Rules:\n- Always use current_time for date/time.\n- Use search_memory for personal facts.\n"
        "- Use search_chat_history for past conversations.\n- Use web_search for changing facts.\n"
        "- Do NOT make up information that a tool search could verify."
    )


def build_intent_context(user_message: str | None, *, locale: str | None = None) -> dict[str, Any]:
    raw_message = sanitize_text(user_message or "", 2_000)
    lowered = raw_message.lower()
    locale_hint = sanitize_text(locale or "auto", 40)
    is_arabic = any("\u0600" <= c <= "\u06ff" for c in raw_message)
    is_egyptian = is_arabic and any(m in raw_message for m in _EGYPTIAN_ARABIC_MARKERS)

    risk_flags: list[str] = []
    avoid: list[str] = []
    detected_signals: list[str] = []
    situation_type = "general_support"
    core_problem, user_need = "", ""
    answer_strategy = "Respond to the user's actual underlying concern with one concrete next step."
    force_response_mode: ResponseMode | None = None

    if any(m in lowered for m in _SELF_HARM_MARKERS):
        situation_type, force_response_mode = "self_harm_or_safety", "ambiguous_self_harm_support"
        risk_flags.append("possible_self_harm")
        detected_signals.append("self_harm_language")
        answer_strategy = "Ask one direct safety question and give a short immediate safety step."
    elif any(m in lowered for m in _RELATIONSHIP_DANGER_MARKERS):
        situation_type, force_response_mode = "relationship_safety", "personal_safety"
        risk_flags.append("possible_control_or_violence")
        detected_signals.append("relationship_danger")
        answer_strategy = "Prioritize immediate safety, distance, trusted support, and emergency help."
        avoid.extend(["confrontation scripts", "spend a day apart as the only advice"])
    elif any(m in lowered for m in _RELATIONSHIP_MARKERS) or any(m in lowered for m in _RELATIONSHIP_INVALIDATION_MARKERS):
        situation_type, force_response_mode = "relationship_distress", "relationship_distress"
        detected_signals.append("relationship_context")
        core_problem = "relationship conflict or distress"
        if any(m in lowered for m in _RELATIONSHIP_INVALIDATION_MARKERS):
            risk_flags.append("possible_emotional_invalidation")
            core_problem = "long-term criticism, invalidation, and emotional exhaustion"
            user_need = "needs validation, safety/support check, and one concrete next step"
            avoid.extend(["generic identity questions", "diagnosing the spouse", "normalizing humiliation"])
    elif situation_type == "general_support" and any(m in lowered for m in _PANIC_MARKERS):
        situation_type, force_response_mode = "panic", "panic_grounding"
        detected_signals.append("panic")
        answer_strategy = "Give one short grounding instruction first."
    elif situation_type == "general_support" and any(m in lowered for m in _ANGER_MARKERS):
        situation_type, force_response_mode = "anger_impulse", "anger_deescalation"
        detected_signals.append("anger_or_impulse")
        answer_strategy = "Interrupt the impulse with a physical action and a short delay."
    elif situation_type == "general_support" and any(m in lowered for m in _STUDY_MARKERS):
        situation_type, force_response_mode = "study_stress", "study_stress"
        detected_signals.append("study_or_exam")
        answer_strategy = "Name the bottleneck and assign one timed task."
    elif situation_type == "general_support" and any(m in lowered for m in _GRIEF_MARKERS):
        situation_type = "grief"
        detected_signals.append("grief")
        answer_strategy = "Acknowledge the loss plainly and ask one grounded question."

    if is_egyptian:
        language_style = "egyptian_arabic"
    elif is_arabic:
        language_style = "arabic"
    elif any(m in raw_message for m in _SPANISH_MARKERS):
        language_style = "spanish"
    elif any(m in raw_message for m in _FRENCH_MARKERS):
        language_style = "french"
    else:
        language_style = "english"

    return {
        "language_style": language_style,
        "locale_hint": locale_hint,
        "situation_type": situation_type,
        "core_problem": core_problem or situation_type.replace("_", " "),
        "user_need": user_need,
        "risk_flags": _unique_list(risk_flags),
        "avoid": _unique_list(avoid),
        "answer_strategy": answer_strategy,
        "detected_signals": _unique_list(detected_signals),
        "force_response_mode": force_response_mode,
    }


def infer_response_mode(
    *,
    safety_level: str = "safe",
    rag_tags: list[str] | tuple[str, ...] | None = None,
    user_message: str | None = None,
    intent_context: dict[str, Any] | None = None,
) -> ResponseMode:
    normalized_safety = _normalize_safety_level(safety_level)
    tags = {sanitize_text(str(tag), 80).lower() for tag in (rag_tags or [])}
    message = sanitize_text(user_message or "", 1_000).lower()
    intent = intent_context or build_intent_context(user_message)

    if normalized_safety in ("self_harm_imminent", "abuse_or_violence"):
        return "personal_safety"
    if normalized_safety == "self_harm_ambiguous":
        return "ambiguous_self_harm_support"
    if normalized_safety == "toxicity":
        return "anger_deescalation"

    if (forced := sanitize_text(str(intent.get("force_response_mode") or ""), 80)) in ALLOWED_RESPONSE_MODES:
        return forced  # type: ignore[return-value]
    if {"panic_grounding", "54321_grounding", "grounding_54321", "box_breathing", "anxiety"}.intersection(tags) or any(m in message for m in _PANIC_MARKERS):
        return "panic_grounding"
    if {"dbt_stop", "anger", "impulse"}.intersection(tags) or any(m in message for m in _ANGER_MARKERS):
        return "anger_deescalation"
    if {"emotion_labeling", "reflection", "cognitive_reframe"}.intersection(tags):
        return "emotion_labeling"
    if {"relationship", "relationship_distress"}.intersection(tags) or any(m in message for m in _RELATIONSHIP_MARKERS) or any(m in message for m in _RELATIONSHIP_INVALIDATION_MARKERS):
        return "relationship_distress"
    if {"study_stress", "exam_anxiety"}.intersection(tags) or any(m in message for m in _STUDY_MARKERS):
        return "study_stress"
    return "normal_support"


def infer_response_mode_for_preference(
    *,
    preference: str | None = None,
    safety_level: str = "safe",
    rag_tags: list[str] | tuple[str, ...] | None = None,
    user_message: str | None = None,
    intent_context: dict[str, Any] | None = None,
) -> ResponseMode:
    normalized_safety = _normalize_safety_level(safety_level)
    intent = intent_context or build_intent_context(user_message)

    if normalized_safety in ("self_harm_imminent", "abuse_or_violence"):
        return "personal_safety"
    if normalized_safety == "self_harm_ambiguous":
        return "ambiguous_self_harm_support"

    if (forced := sanitize_text(str(intent.get("force_response_mode") or ""), 80)) in SAFETY_OVERRIDE_MODES:
        return forced  # type: ignore[return-value]

    inferred_base = infer_response_mode(safety_level=safety_level, rag_tags=rag_tags, user_message=user_message, intent_context=intent)
    if inferred_base in {"personal_safety", "ambiguous_self_harm_support", "panic_grounding", "relationship_distress"}:
        return inferred_base

    normalized_pref = sanitize_text(str(preference or ""), 80).lower().replace(" ", "_") if preference else None
    allowed_family = PREFERENCE_MODE_FAMILIES.get(normalized_pref, ALLOWED_RESPONSE_MODES) if normalized_pref else ALLOWED_RESPONSE_MODES
    return inferred_base if inferred_base in allowed_family else "normal_support"


def resolve_response_mode(
    *,
    frontend_mode: str | None = None,
    inferred_mode: ResponseMode = "normal_support",
    safety_level: str = "safe",
) -> ResponseMode:
    normalized_safety = _normalize_safety_level(safety_level)
    if normalized_safety in ("self_harm_imminent", "abuse_or_violence"):
        return "personal_safety"
    if normalized_safety == "self_harm_ambiguous":
        return "ambiguous_self_harm_support"
    if not frontend_mode:
        return inferred_mode
    normalized_pref = sanitize_text(str(frontend_mode), 80).lower().replace(" ", "_")
    allowed_family = PREFERENCE_MODE_FAMILIES.get(normalized_pref)
    if not allowed_family or inferred_mode in allowed_family:
        return inferred_mode
    return "normal_support" if "normal_support" in allowed_family else next(iter(allowed_family), "normal_support")  # type: ignore[return-value]


def _resolve_detected_language_block(intent_context: dict[str, Any] | None) -> str:
    if not intent_context:
        return ""
    style = intent_context.get("language_style", "")
    if style == "egyptian_arabic":
        return "DETECTED LANGUAGE: Egyptian Arabic. Respond in natural Egyptian Arabic dialect."
    if style == "arabic":
        return "DETECTED LANGUAGE: Arabic. Respond in Arabic matching user register."
    if style == "spanish":
        return "DETECTED LANGUAGE: Spanish. Respond entirely in Spanish."
    if style == "french":
        return "DETECTED LANGUAGE: French. Respond entirely in French."
    if style == "english":
        return "DETECTED LANGUAGE: English. Respond entirely in English."
    return ""


def _render_intent_context(intent_context: dict[str, Any] | None) -> str:
    if not intent_context:
        return ""
    allowed = ("language_style", "situation_type", "core_problem", "user_need", "risk_flags", "avoid", "answer_strategy", "detected_signals")
    compact = {k: intent_context.get(k) for k in allowed if intent_context.get(k)}
    if not compact:
        return ""
    serialized = sanitize_text(json.dumps(compact, ensure_ascii=False, separators=(",", ":")), MAX_INTENT_CONTEXT_CHARS)
    return f"Semantic intake context. Do not expose this JSON directly:\n{serialized}"


def _render_user_preferences(user_preferences: str | None) -> str:
    cleaned = sanitize_text(user_preferences or "", MAX_USER_PREFERENCES_CHARS)
    return f"User communication preferences, sanitized:\n{cleaned}" if cleaned else ""


def _render_memory(memory_summary: str | None) -> str:
    cleaned = sanitize_text(memory_summary or "", MAX_MEMORY_PROMPT_CHARS)
    return f"User memory summary, sanitized and compacted:\n{cleaned}" if cleaned else ""


def _render_rag_grounding(rag_grounding: list[dict[str, Any]] | None) -> str:
    if not rag_grounding:
        return ""
    compact_items = [
        {str(k): _compact_value(v, max_chars=MAX_RAG_ITEM_CHARS, depth=2) for k, v in item.items() if str(k).strip()}
        for item in rag_grounding[:MAX_RAG_ITEMS] if isinstance(item, Mapping)
    ]
    if not compact_items:
        return ""
    serialized = safe_truncate(json.dumps(compact_items, ensure_ascii=False, separators=(",", ":")), MAX_RAG_ITEMS * MAX_RAG_ITEM_CHARS)
    return f"Retrieved wellness grounding notes:\n{serialized}"


def _compact_value(value: Any, *, max_chars: int, depth: int) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return sanitize_text(value, max_chars)
    if depth <= 0:
        return safe_truncate(str(value), max_chars)
    if isinstance(value, Mapping):
        return {safe_truncate(str(k), 80): _compact_value(v, max_chars=max_chars, depth=depth - 1) for k, v in list(value.items())[:20] if str(k).strip()}
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_compact_value(item, max_chars=max_chars, depth=depth - 1) for item in list(value)[:20]]
    return safe_truncate(str(value), max_chars)


def _unique_list(values: list[str]) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []
    for v in values:
        if (clean := sanitize_text(v, 120)) and clean not in seen:
            seen.add(clean)
            output.append(clean)
    return output


def _normalize_response_mode(value: str) -> ResponseMode:
    normalized = sanitize_text(str(value or "normal_support"), 80)
    return normalized if normalized in ALLOWED_RESPONSE_MODES else "normal_support"  # type: ignore[return-value]


def _normalize_safety_level(value: str) -> str:
    normalized = sanitize_text(str(value or "safe"), 80)
    return normalized if normalized in get_safety_level_instructions() else "safe"


def _normalize_channel(value: str) -> Channel:
    normalized = sanitize_text(str(value or "web"), 80)
    return normalized if normalized in ("web", "discord", "api", "test", "unknown") else "unknown"  # type: ignore[return-value]


__all__ = [
    "CLINICAL_PRO_PROMPT", "PRODUCT_BOUNDARY_PROMPT", "SAFETY_STYLE_PROMPT",
    "STANDARD_AGENT_CHAIN_PROMPT", "WELLNESS_ASSISTANT_PROMPT",
    "ALLOWED_RESPONSE_MODES", "PREFERENCE_MODE_FAMILIES", "SAFETY_OVERRIDE_MODES",
    "VALID_RAG_TAGS", "Channel", "PromptPolicy", "ResponseMode",
    "build_intent_context", "build_prompt_policy", "build_system_prompt",
    "build_time_context", "build_tool_instructions", "infer_response_mode",
    "infer_response_mode_for_preference", "render_system_prompt", "resolve_response_mode",
]