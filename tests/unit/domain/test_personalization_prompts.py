# tests/unit/domain/test_personalization_prompts.py

from __future__ import annotations

import pytest
from backend.models.user import UserProfile, UserPreferences
from backend.services.domain.llm.chat_orchestrator import build_user_preferences_prompt


def test_personalization_prompt_directives_friendly_high_warmth():
    profile = UserProfile(
        user_id_hash="test_user_hash_1",
        preferences=UserPreferences(
            ui_settings={
                "personalization": {
                    "baseStyle": "friendly",
                    "warmth": "high",
                    "useHeadersLists": True,
                    "emojiSupport": True,
                }
            }
        ),
    )

    prompt = build_user_preferences_prompt(profile)
    assert "tone=friendly, warm, and encouraging" in prompt
    assert "warmth_level=high empathy and strong validation" in prompt
    assert "formatting=use clear headers and bullet points for complex topics" in prompt
    assert "emoji_policy=gentle warm emojis allowed when natural" in prompt


def test_personalization_prompt_directives_candid_low_warmth_no_emoji():
    profile = UserProfile(
        user_id_hash="test_user_hash_2",
        preferences=UserPreferences(
            ui_settings={
                "personalization": {
                    "baseStyle": "candid",
                    "warmth": "low",
                    "useHeadersLists": False,
                    "emojiSupport": False,
                }
            }
        ),
    )

    prompt = build_user_preferences_prompt(profile)
    assert "tone=candid, direct, and straightforward" in prompt
    assert "warmth_level=grounded and practical with minimal emotional flair" in prompt
    assert "formatting=use natural conversational prose, avoid bulleted lists" in prompt
    assert "emoji_policy=strictly no emojis in responses" in prompt


def test_personalization_prompt_directives_quirky_professional():
    quirky_profile = UserProfile(
        user_id_hash="test_user_hash_3",
        preferences=UserPreferences(
            ui_settings={
                "personalization": {
                    "baseStyle": "quirky",
                }
            }
        ),
    )
    quirky_prompt = build_user_preferences_prompt(quirky_profile)
    assert "tone=creative, warm, and subtly playful" in quirky_prompt

    prof_profile = UserProfile(
        user_id_hash="test_user_hash_4",
        preferences=UserPreferences(
            ui_settings={
                "personalization": {
                    "baseStyle": "professional",
                }
            }
        ),
    )
    prof_prompt = build_user_preferences_prompt(prof_profile)
    assert "tone=professional, structured, and measured" in prof_prompt
