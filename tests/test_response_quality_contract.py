from __future__ import annotations

import importlib
import inspect

import pytest

chat_router_module = importlib.import_module("backend.api.chat_router")
chat_stream_router_module = importlib.import_module("backend.api.chat_stream_router")
from backend.core.message_classifier import classify_message
from backend.core.prompt_builder import build_tiered_prompt
from backend.core.prompts import build_system_prompt
from backend.services.response_quality_service import finalize_user_reply


@pytest.mark.parametrize(
    ("message", "clinical_mode", "expected_tier"),
    [
        ("Hey, I had a rough meeting today.", False, "casual"),
        ("I keep replaying my argument with my brother and cannot sleep.", False, "emotional"),
        ("I have been overwhelmed for months and want to understand the pattern.", True, "clinical"),
        ("حاسس إني مضغوط من الشغل ومش عارف أنام.", False, "emotional"),
    ],
)
def test_clear_contract_replaces_legacy_visible_reasoning_format(
    message: str,
    clinical_mode: bool,
    expected_tier: str,
) -> None:
    """The revised prompts must guide useful answers without demanding thought output."""
    classification = classify_message(message, locale="auto", clinical_mode=clinical_mode)
    assert classification.tier == expected_tier

    improved = build_tiered_prompt(
        classification=classification,
        locale="auto",
        clinical_mode=clinical_mode,
        intent_context_str='Semantic intake context: {"user_need":"support"}',
    )
    legacy = build_system_prompt(
        "",
        [],
        "auto",
        clinical_mode=clinical_mode,
        intent_context={"language_style": classification.language},
    )

    # Baseline behavior required the model to emit a two-block reasoning format.
    assert "thought block" in legacy.lower()
    # Revised behavior makes a direct, tailored reply an explicit contract.
    assert "clear response contract:" in improved.lower()
    assert "lead with a direct answer" in improved.lower()
    assert "offer one to three concrete next steps" in improved.lower()
    # It may name legacy labels only to prohibit them; it must never require them.
    assert "write your full internal reasoning" not in improved.lower()
    assert "you must use this exact output format" not in improved.lower()


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (
            "**Thought:** The user is anxious. I should validate them.\n\n"
            "**Response:** It makes sense that the meeting is still on your mind. "
            "Try writing down the one comment you are replaying, then step away for five minutes.",
            "It makes sense that the meeting is still on your mind. "
            "Try writing down the one comment you are replaying, then step away for five minutes.",
        ),
        (
            "<analysis>Private plan that must not be shown.</analysis>\n"
            "**Balanced Reframe:** You are not failing; you are carrying a lot at once.",
            "You are not failing; you are carrying a lot at once.",
        ),
        (
            "A direct answer without a wrapper should stay unchanged.",
            "A direct answer without a wrapper should stay unchanged.",
        ),
    ],
)
def test_finalizer_removes_only_known_internal_output_wrappers(raw: str, expected: str) -> None:
    assert finalize_user_reply(raw) == expected
    assert finalize_user_reply(finalize_user_reply(raw)) == expected


def test_both_chat_routes_use_the_same_tiered_prompt_and_finalizer() -> None:
    """Streaming and non-streaming experiences must not diverge by endpoint."""
    standard_source = inspect.getsource(chat_router_module.chat)
    stream_source = inspect.getsource(chat_stream_router_module.chat_stream)

    assert "build_tiered_prompt(" in standard_source
    assert "build_tiered_prompt(" in stream_source
    assert "finalize_user_reply(" in standard_source
    assert "finalize_user_reply(" in stream_source


def test_adaptive_presentation_contract_supports_rich_markdown_without_forcing_it() -> None:
    classification = classify_message(
        "Compare two ways to ask my manager for a deadline extension.",
        locale="en",
        clinical_mode=False,
    )
    prompt = build_tiered_prompt(classification=classification, locale="en")

    assert "adaptive presentation:" in prompt.lower()
    assert "use a compact markdown table only for a true comparison" in prompt.lower()
    assert "include markdown links only for tool-provided, verified sources" in prompt.lower()
    assert "thought block" not in prompt.lower()
    assert "must contain only your thought block and response block" not in prompt.lower()
