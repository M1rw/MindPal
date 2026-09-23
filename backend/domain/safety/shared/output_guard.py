# backend/domain/safety/output_guard.py — Stream Output Guard

from __future__ import annotations

import re
from contextlib import aclosing
from typing import AsyncGenerator

from backend.configs.runtime import safety_config

# Boilerplate that breaks the companion voice. Written against the accumulated
# text, so a phrase split across token boundaries still matches.
_SAFETY_CONFIG = safety_config()
_PROHIBITED_PATTERNS = [
    re.compile(pattern, re.IGNORECASE)
    for pattern in _SAFETY_CONFIG["output_guard"]["prohibited_patterns"]
]

# The longest prohibited phrase, plus slack. Only this much tail needs to be
# re-examined as new tokens arrive; matching against the whole transcript made
# every token cost more than the one before it, so a long reply degraded into
# quadratic regex work while the caller waited on the stream.
_SCAN_WINDOW_CHARS = int(_SAFETY_CONFIG["output_guard"]["scan_window_chars"])


class OutputGuardService:
    """Best-effort live filter. Does not delay the stream behind a full buffer."""

    async def guard_stream(self, token_stream: AsyncGenerator[str, None]) -> AsyncGenerator[str, None]:
        tail = ""
        async with aclosing(token_stream) as stream:
            async for token in stream:
                if not token:
                    continue
                trial = tail + token
                if any(pattern.search(trial) for pattern in _PROHIBITED_PATTERNS):
                    # Drop the token and keep the tail unchanged: the next token
                    # is judged against the same context, so a phrase cannot be
                    # smuggled through by splitting it differently.
                    continue
                tail = trial[-_SCAN_WINDOW_CHARS:]
                yield token


_STOCK_SENTENCES = [
    re.compile(r"^\s*(?:" + pattern + r")", re.IGNORECASE)
    for pattern in _SAFETY_CONFIG["output_guard"].get("stock_sentences", [])
]
_STOCK_MAX_CHARS = int(_SAFETY_CONFIG["output_guard"].get("stock_sentence_max_chars", 110))
# First words a stock sentence can start with. Any other first word releases the
# sentence at once, so ordinary replies are never held back.
_STOCK_LEADS = frozenset(w.lower() for w in _SAFETY_CONFIG["output_guard"].get("stock_sentence_leads", []))
# How much of a candidate sentence's start is held back to decide whether it is filler.
_DECIDE_CHARS = 60
_SENTENCE_END = re.compile(r"[.!?؟…]+[\"')\]]*(?:\s+|$)|\n+")


def is_stock_sentence(sentence: str) -> bool:
    text = sentence.strip()
    return bool(text) and len(text) <= _STOCK_MAX_CHARS and any(p.search(text) for p in _STOCK_SENTENCES)


class StockSentenceFilter:
    """Drops short stock-sympathy sentences ("It's completely valid to feel that way.").

    Only the first ~60 characters of each sentence are held back; a sentence
    that does not start like filler streams on immediately. A reply is never
    emptied: if every sentence was filler, the last one is kept.
    """

    def __init__(self) -> None:
        self.dropped = 0

    async def filter(self, token_stream: AsyncGenerator[str, None]) -> AsyncGenerator[str, None]:
        pending = ""  # held start of the current sentence
        passing = False  # current sentence already cleared as not filler
        yielded = False
        last_dropped = ""
        async with aclosing(token_stream) as stream:
            async for token in stream:
                if not token:
                    continue
                if passing:
                    end = _SENTENCE_END.search(token)
                    if end:
                        yield token[: end.end()]
                        yielded = True
                        passing = False
                        pending = token[end.end():]
                    else:
                        yield token
                        yielded = True
                        continue
                else:
                    pending += token
                while pending:
                    end = _SENTENCE_END.search(pending)
                    if end:
                        sentence, pending = pending[: end.end()], pending[end.end():]
                        if is_stock_sentence(sentence):
                            self.dropped += 1
                            last_dropped = sentence
                            continue
                        yield sentence
                        yielded = True
                        continue
                    stripped = pending.lstrip()
                    first_word = stripped.split(" ", 1)[0].lower() if " " in stripped else ""
                    candidate = any(p.search(pending) for p in _STOCK_SENTENCES)
                    not_a_lead = bool(first_word) and first_word not in _STOCK_LEADS
                    if not_a_lead or (len(pending) >= _DECIDE_CHARS and (not candidate or len(pending) > _STOCK_MAX_CHARS)):
                        yield pending
                        yielded = True
                        pending = ""
                        passing = True
                    break
        if pending:
            if is_stock_sentence(pending) and yielded:
                self.dropped += 1
            else:
                yield pending
                yielded = True
        if not yielded and last_dropped:
            self.dropped -= 1
            yield last_dropped
