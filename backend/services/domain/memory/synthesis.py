# backend/services/domain/memory/synthesis.py

from __future__ import annotations

import logging
import re
from typing import Any, Sequence

from backend.core.security import normalize_locale, sanitize_text
from backend.models.memory import MemoryInteraction, MemoryInteractionRole, MemoryGraph
from backend.services.domain.llm.request_builder import build_llm_request
from backend.services.domain.llm.service import LLMService

logger = logging.getLogger(__name__)

ARABIC_CHAR_PATTERN: re.Pattern[str] = re.compile(r"[\u0600-\u06ff]")


def detect_user_language(
    user_texts: Sequence[str] = (),
    edit_instruction: str = "",
    fallback_locale: str = "auto",
) -> str:
    """
    Auto-detect dominant language from user conversation history and instructions with fallback.

    Fallback chain:
      1. Dominant script/language in user conversation text and edit instruction
      2. Normalized fallback_locale (if not "auto")
      3. Default "en"
    """
    all_texts = list(user_texts)
    if edit_instruction:
        all_texts.append(edit_instruction)

    combined_text = " ".join(sanitize_text(text, 2000) for text in all_texts if text).strip()

    if combined_text:
        arabic_count = len(ARABIC_CHAR_PATTERN.findall(combined_text))
        total_alpha = sum(1 for c in combined_text if c.isalpha())

        if total_alpha > 0 and (arabic_count / total_alpha) > 0.25:
            return "ar"
        if total_alpha > 0 and (arabic_count / total_alpha) <= 0.25:
            return "en"

    # Fallback to locale setting
    normalized = normalize_locale(fallback_locale or "auto")
    if normalized and normalized != "auto":
        if normalized.startswith("ar"):
            return "ar"
        return normalized[:2]

    return "en"


def build_synthesis_system_prompt(target_language: str) -> str:
    """
    Construct the system prompt instructing the model to synthesize a narrative user memory profile.
    """
    lang_name = "Arabic" if target_language.startswith("ar") else "English" if target_language.startswith("en") else target_language

    return f"""
You are MindPal's memory synthesis engine.
Your task is to synthesize what MindPal knows about the user into a rich, cohesive, warm, and well-structured narrative document written in Markdown.

CRITICAL LANGUAGE REQUIREMENT:
- You MUST write the ENTIRE narrative profile in {lang_name} ({target_language}).
- Do NOT output English if the target language is Arabic ({target_language} = "ar").

NARRATIVE FORMAT & STRUCTURE:
- Structure the profile with clear, content-driven Markdown section headers whenever source material allows:
  * `## Overview` (core identity, present state, active focus)
  * `## Work & Studies` (career, education, current projects, ambitions)
  * `## Emotional Patterns & Coping` (stressors, feelings, reflection style)
  * `## What Helps` (effective strategies, relaxing activities, support systems)
  * `## Personal Preferences` (communication style, tone, boundaries)
- Under each section header, write rich, descriptive sentences drawing directly from the user's conversation history and facts. Do NOT compress or summarize into a single brief sentence or ellipsis.
- If very little is known, produce an `## Overview` section with whatever genuine details exist.
- Write in warm, respectful, third-person perspective ("The user...", "They...", or in Arabic "يفضل...", "يعمل في...").
- Keep the tone private, supportive, and non-clinical.
- Do NOT invent or assume facts not grounded in the input facts or conversation.
- If an edit instruction is provided, apply the change directly: new statements supersede old contradictory facts.
""".strip()


async def synthesize_memory_narrative(
    *,
    llm_service: LLMService | None,
    user_texts: Sequence[str] = (),
    existing_narrative: str = "",
    edit_instruction: str = "",
    extracted_facts: Sequence[str] = (),
    fallback_locale: str = "auto",
    request_id: str = "mem_synth",
) -> tuple[str, str]:
    """
    Synthesize narrative memory profile and detect language.

    Returns:
        tuple[narrative_text, detected_language_code]
    """
    detected_lang = detect_user_language(user_texts, edit_instruction=edit_instruction, fallback_locale=fallback_locale)

    # Build input context for synthesis
    context_parts: list[str] = [f"Detected target language: {detected_lang}"]

    if existing_narrative.strip():
        context_parts.append(f"Current Narrative Summary:\n{existing_narrative.strip()}")

    if edit_instruction.strip():
        context_parts.append(f"User Edit Request (SUPERSEDES contradicting prior info):\n{edit_instruction.strip()}")

    if extracted_facts:
        facts_text = "\n".join(f"- {f}" for f in extracted_facts if f.strip())
        if facts_text:
            context_parts.append(f"Extracted Facts:\n{facts_text}")

    if user_texts:
        recent_convo = "\n".join(f"- {t}" for t in user_texts[-20:] if t.strip())
        if recent_convo:
            context_parts.append(f"Recent User Conversation Snippets:\n{recent_convo}")

    user_message = "\n\n".join(context_parts)

    if not llm_service or not getattr(llm_service, "is_configured", True):
        # Fallback offline synthesis if LLM is unavailable
        return _fallback_offline_narrative(existing_narrative, edit_instruction, extracted_facts, detected_lang), detected_lang

    try:
        sys_prompt = build_synthesis_system_prompt(detected_lang)
        req = build_llm_request(
            request_id=request_id,
            system_prompt=sys_prompt,
            user_message=user_message,
            temperature=0.2,
            max_output_tokens=1_200,
            metadata={"purpose": "narrative_memory_synthesis", "language": detected_lang},
        )
        res = await llm_service.generate(req)
        narrative = res.text.strip()
        # If offline/canned response was returned or missing Markdown structure, use fallback narrative
        if narrative and "##" in narrative and (not detected_lang.startswith("ar") or len(ARABIC_CHAR_PATTERN.findall(narrative)) > 0):
            return narrative, detected_lang
    except Exception as exc:
        logger.warning("LLM narrative memory synthesis failed, using deterministic fallback: %s", exc)

    return _fallback_offline_narrative(existing_narrative, edit_instruction, extracted_facts, detected_lang), detected_lang


def _fallback_offline_narrative(
    existing: str,
    instruction: str,
    facts: Sequence[str],
    lang: str,
) -> str:
    """
    Deterministic offline fallback narrative generation when LLM is unavailable.
    """
    is_ar = lang.startswith("ar")

    if instruction.strip():
        if existing.strip():
            header = "## ملخص الذاكرة المحدث" if is_ar else "## Updated Memory Summary"
            return f"{header}\n\n{existing.strip()}\n\n* {instruction.strip()}"
        header = "## نبذة عامة" if is_ar else "## Overview"
        return f"{header}\n\n{instruction.strip()}"

    if existing.strip():
        return existing.strip()

    if facts:
        header = "## نبذة عامة" if is_ar else "## Overview"
        facts_lines = "\n".join(f"- {f}" for f in facts if f.strip())
        return f"{header}\n\n{facts_lines}"

    if is_ar:
        return "## نبذة عامة\n\nيتذكر مايند بال تفضلاتك وسياقك العاطفي لدعمك برفق."
    return "## Overview\n\nMindPal remembers your preferences and emotional context to support you gently."
