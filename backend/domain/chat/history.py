# backend/domain/chat/history.py — Conversation history contract for the LLM turn

from __future__ import annotations

from typing import Any, Iterable, Mapping, Sequence

from backend.configs.runtime import behavior_config, domain_limits_config

MAX_HISTORY_FOR_LLM = int(domain_limits_config()["chat_history"]["max_history_for_llm"])

_CHAT_BEHAVIOR = behavior_config()["chat"]
_ASSISTANT_ROLES = frozenset(_CHAT_BEHAVIOR["assistant_roles"])
_USER_ROLES = frozenset(_CHAT_BEHAVIOR["user_roles"])


def _role(item: Any) -> str:
    raw = ""
    if isinstance(item, Mapping):
        raw = str(item.get("role") or "")
    else:
        raw = str(getattr(item, "role", "") or "")
    role = raw.strip().lower()
    if role in _ASSISTANT_ROLES:
        return "assistant"
    if role in _USER_ROLES:
        return "user"
    return ""


def _content(item: Any) -> str:
    if isinstance(item, Mapping):
        return str(item.get("content") or item.get("text") or "").strip()
    content = getattr(item, "content", None)
    if content:
        return str(content).strip()
    text = getattr(item, "text", None)
    return str(text or "").strip()


def normalize_history(
    history: Sequence[Any] | Iterable[Any] | None,
    current_message: str,
    *,
    max_turns: int = MAX_HISTORY_FOR_LLM,
) -> list[dict[str, str]]:
    """
    Contract: history is prior turns only.

    If the client also appended the active user message, drop that trailing
    duplicate *before* slicing so a long thread does not keep the duplicate
    and lose older context.
    """
    raw = list(history or [])
    current = (current_message or "").strip()

    while raw:
        last = raw[-1]
        if _role(last) == "user" and current and _content(last) == current:
            raw.pop()
            continue
        break

    sliced = raw[-max_turns:] if max_turns > 0 else []
    normalized: list[dict[str, str]] = []
    for item in sliced:
        role = _role(item)
        content = _content(item)
        if role not in {"user", "assistant"} or not content:
            continue
        normalized.append({"role": role, "content": content})
    return normalized
