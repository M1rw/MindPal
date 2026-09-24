"""Reply shape: the prompt sizes replies to the message, the guard drops sign-offs,
and the eval scorer can tell a good short reply from a wall of text."""

from __future__ import annotations

import asyncio

from backend.domain.chat.orchestrator import personalization_note
from backend.domain.chat.routing import reply_size_note
from backend.domain.safety.shared.output_guard import StockSentenceFilter, is_stock_sentence
from backend.tools.reply_quality import score_reply

# What production sent for "I feel stuck" before prompts v2.
WALL = (
    "That’s one of the heaviest, most suffocating feelings, isn’t it? It’s not just about not knowing what to do next; "
    "it’s that the ground feels like it’s vanished, and every direction looks like a dead end.\n\n"
    "I’m here with you in that stillness. You don’t have to fix it right now, and you don’t have to have a plan.\n\n"
    "To help us see where we are, can you tell me a little more about what “stuck” looks like for you today?\n"
    "*   Is it a specific decision you’re avoiding?\n*   Is it a repeating pattern that keeps happening?\n"
    "*   Or is it more of a general fog, where you just can’t seem to find any motivation or joy?\n\n"
    "Take your time. I’m listening. 🌿"
)


def _filtered(text: str) -> tuple[str, int]:
    async def tokens():
        for i in range(0, len(text), 7):
            yield text[i : i + 7]

    async def run():
        guard = StockSentenceFilter()
        out = "".join([t async for t in guard.filter(tokens())])
        return out, guard.dropped

    return asyncio.run(run())


def test_short_messages_get_a_concrete_size() -> None:
    assert "one or two short sentences" in reply_size_note("hi")
    assert "one or two short sentences" in reply_size_note("هلا")
    assert "a few sentences" in reply_size_note("my boss yelled at me in front of everyone today")
    assert reply_size_note("what should I do about my job?") == ""  # they asked for help: no cap
    assert reply_size_note("hi", {"baseStyle": "detailed"}) == ""
    assert reply_size_note("word " * 80) == ""


def test_default_personalization_does_not_ask_for_emoji_or_sympathy() -> None:
    note = personalization_note({"baseStyle": "balanced", "warmth": "warm", "useHeadersLists": True, "emojiSupport": True})
    assert "enhance emotional resonance" not in note
    assert "none when they are struggling" in note
    assert "not through sympathy phrases" in note


def test_guard_drops_sign_offs_with_curly_apostrophes_and_their_emoji() -> None:
    out, dropped = _filtered("Stuck how, like one decision or more of a fog?\n\nI’m here with you in that stillness. Take your time. I’m listening. 🌿")
    assert out.strip() == "Stuck how, like one decision or more of a fog?"
    assert dropped == 3


def test_guard_keeps_real_sentences_that_share_the_words() -> None:
    assert not is_stock_sentence("Take your time to decide which one fits.")
    assert not is_stock_sentence("I’m listening to a podcast about it.")
    out, dropped = _filtered("Congrats!! That's huge 🎉")
    assert out == "Congrats!! That's huge 🎉" and dropped == 0
    out, _ = _filtered("Take your time.")
    assert out == "Take your time.", "a reply is never emptied"


def test_scorer_separates_a_wall_of_text_from_a_friendly_reply() -> None:
    bad = score_reply("I feel stuck", WALL, category="venting")
    good = score_reply("I feel stuck", "Stuck like a decision you keep circling, or more of a general fog?", category="venting")
    assert bad.score < 50 and good.score > 90
    assert {"length_fit", "paragraphs", "questions", "emoji", "markdown"} <= set(bad.flags)
    assert "take your time" in bad.stats["stock"] and "i'm listening" in bad.stats["stock"]


def test_scorer_checks_language_and_allows_depth_when_asked() -> None:
    assert score_reply("هلا", "Hey! How's it going?").factors["language"] == 0.0
    assert score_reply("هلا", "هلا والله! كيف يومك؟").factors["language"] == 1.0
    steps = "Here are a few options:\n- Start with 20 minutes a day.\n- Keep a list.\n- Tell a friend your deadline.\nWhich feels doable?"
    assert score_reply("Give me some options to stop procrastinating on my thesis", steps, category="advice").score > 90
