# backend/services/domain/safety/classifier.py

from __future__ import annotations

import hashlib
from backend.core.security import sanitize_text


def hash_matched_fragment(fragment: str) -> str:
    """
    Generate a cryptographic BLAKE2b pseudonymized hash for a matched text fragment.

    Args:
        fragment: Raw text snippet that triggered safety rule.

    Returns:
        Pseudonymized match reference identifier string.
    """
    cleaned = sanitize_text(fragment, 300)
    digest = hashlib.blake2b(
        cleaned.encode("utf-8"),
        digest_size=16,
        person=b"MindPalSafety",
    ).hexdigest()
    return f"match_{digest}"


def strip_code_fence(text: str) -> str:
    """
    Strip surrounding Markdown triple-backtick code fences from text.

    Args:
        text: Input raw response string.

    Returns:
        Unfenced text content.
    """
    stripped = text.strip()

    if not stripped.startswith("```"):
        return stripped

    lines = stripped.splitlines()

    if lines and lines[0].startswith("```"):
        lines = lines[1:]

    if lines and lines[-1].strip().startswith("```"):
        lines = lines[:-1]

    return "\n".join(lines).strip()
