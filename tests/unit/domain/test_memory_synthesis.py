# tests/unit/domain/test_memory_synthesis.py

from __future__ import annotations

import pytest
from backend.services.domain.memory.synthesis import (
    build_synthesis_system_prompt,
    detect_user_language,
    synthesize_memory_narrative,
)


def test_language_detection_english():
    texts = ["I feel anxious about my upcoming exams", "What coping strategies can I use?"]
    lang = detect_user_language(texts, fallback_locale="auto")
    assert lang == "en"


def test_language_detection_arabic():
    texts = ["بحس بتوتر وقلق من الامتحانات", "عايز نصيحة ازاي اتعامل مع الضغط"]
    lang = detect_user_language(texts, fallback_locale="auto")
    assert lang == "ar"


def test_language_detection_mixed_dominant_arabic():
    texts = ["I have exams tomorrow", "مش عارف انام من التوتر والقلق الخديد"]
    lang = detect_user_language(texts, fallback_locale="auto")
    assert lang == "ar"


def test_language_detection_no_conversation_fallback():
    lang_ar = detect_user_language([], fallback_locale="ar-EG")
    assert lang_ar == "ar"

    lang_en = detect_user_language([], fallback_locale="en-US")
    assert lang_en == "en"

    lang_default = detect_user_language([], fallback_locale="auto")
    assert lang_default == "en"


def test_synthesis_system_prompt_language_directives():
    prompt_ar = build_synthesis_system_prompt("ar")
    assert "MUST write the ENTIRE narrative profile in Arabic" in prompt_ar
    assert "Markdown" in prompt_ar

    prompt_en = build_synthesis_system_prompt("en")
    assert "MUST write the ENTIRE narrative profile in English" in prompt_en


@pytest.mark.asyncio
async def test_offline_fallback_narrative_synthesis():
    narrative_en, lang_en = await synthesize_memory_narrative(
        llm_service=None,
        user_texts=["I love walking in nature"],
        existing_narrative="",
        edit_instruction="",
        extracted_facts=["Walking in nature helps user relax"],
        fallback_locale="en",
    )
    assert lang_en == "en"
    assert "## Overview" in narrative_en

    narrative_ar, lang_ar = await synthesize_memory_narrative(
        llm_service=None,
        user_texts=["بحب المشي في الطبيعة"],
        existing_narrative="",
        edit_instruction="",
        extracted_facts=["المشي في الطبيعة يساعد المستخدم على الاسترخاء"],
        fallback_locale="ar",
    )
    assert lang_ar == "ar"
    assert "## نبذة عامة" in narrative_ar


@pytest.mark.asyncio
async def test_offline_fallback_edit_rewriting():
    narrative, lang = await synthesize_memory_narrative(
        llm_service=None,
        user_texts=["I study engineering"],
        existing_narrative="## Overview\n\nUser is studying engineering.",
        edit_instruction="I'm no longer studying engineering, I switched to computer science.",
        fallback_locale="en",
    )
    assert lang == "en"
    assert "computer science" in narrative or "I'm no longer studying engineering" in narrative
