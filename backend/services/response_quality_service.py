"""Deterministic user-visible response quality controls.

This module does not judge or rewrite the model's substance. It protects the
conversation contract by removing internal-plan leakage that prompts, provider
fallbacks, or model drift might otherwise expose to a user.
"""

from __future__ import annotations

import re

from backend.core.security import sanitize_text

MAX_VISIBLE_REPLY_CHARS = 12_000

# If a provider returns the legacy two-block format, only the response block is
# safe and useful to surface. Match common Markdown and plain-text variants.
_INTERNAL_TO_RESPONSE = re.compile(
    r"(?is)^\s*(?:\*{0,2}\s*(?:thought|analysis|reasoning|internal(?:\s+notes?)?)\s*:?\s*\*{0,2})"
    r".*?"
    r"(?:\*{0,2}\s*(?:response|balanced\s+reframe|final(?:\s+answer)?)\s*:?\s*\*{0,2})\s*"
)

# These are labels, not normal conversational phrases. They are stripped only
# at the start of the final reply so ordinary user-facing prose is untouched.
_LEADING_VISIBLE_LABEL = re.compile(
    r"(?is)^\s*(?:\*{0,2}\s*(?:response|balanced\s+reframe|final(?:\s+answer)?)\s*:?\s*\*{0,2})\s*"
)

# Guard against an XML-style internal section emitted by some models.
_XML_INTERNAL_TO_RESPONSE = re.compile(
    r"(?is)^\s*<(?:thought|analysis|reasoning|internal)>.*?</(?:thought|analysis|reasoning|internal)>\s*"
)

# These are narrow, user-visible failure patterns observed when a model starts
# narrating hidden evidence, provider access, or implementation constraints.
# Preserve uncertainty, but restate it as a normal human conversation.
_META_CAPABILITY_REWRITES = (
    (re.compile(r"(?i)\b(?:since\s+)?(?:the\s+)?evidence (?:doesn't|does not) say(?: anything)?(?: about [^,.?!]+)?[,\s]*"), "I don't know that yet. "),
    (re.compile(r"(?i)\b(?:since\s+)?I (?:can't|cannot) search (?:the\s+)?(?:live\s+)?internet[,\s]*"), "I can't verify that right now. "),
    (re.compile(r"(?i)\b(?:you(?:'ll| will) need to|you should) check (?:the )?official documentation[^.?!]*[.?!]?"), ""),
)


def finalize_user_reply(raw_text: str) -> str:
    """Return only user-visible reply content, without private-plan leakage.

    The transformation is intentionally narrow and idempotent: it recognizes
    known legacy output wrappers but does not try to infer or alter content.
    """
    text = sanitize_text(raw_text or "", MAX_VISIBLE_REPLY_CHARS).strip()
    if not text:
        return ""

    text = _INTERNAL_TO_RESPONSE.sub("", text, count=1)
    text = _XML_INTERNAL_TO_RESPONSE.sub("", text, count=1)
    text = _LEADING_VISIBLE_LABEL.sub("", text, count=1)
    for pattern, replacement in _META_CAPABILITY_REWRITES:
        text = pattern.sub(replacement, text)
    return re.sub(r"\s{2,}", " ", text).strip()
