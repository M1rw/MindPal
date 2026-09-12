# backend/services/domain/llm/request_builder.py

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from typing import Any

from backend.models.chat import LLMMessage, LLMRequest, LLMRole

logger = logging.getLogger(__name__)


def build_llm_request(
    *,
    request_id: str,
    system_prompt: str,
    user_message: str,
    history: Sequence[LLMMessage] | None = None,
    temperature: float = 0.4,
    max_output_tokens: int = 700,
    metadata: Mapping[str, Any] | None = None,
) -> LLMRequest:
    """
    Construct a validated LLMRequest with guaranteed system and user message boundaries.

    Args:
        request_id: Unique correlation identifier for tracing.
        system_prompt: Prompt instructing model behavior and constraints.
        user_message: Latest user input query.
        history: Optional sequence of prior conversation messages.
        temperature: Sampling temperature clamped between 0.0 and 2.0.
        max_output_tokens: Maximum token budget for response generation.
        metadata: Key-value attributes for auditing and tracing context.

    Returns:
        LLMRequest domain model initialized with formatted message hierarchy.
    """
    clamped_temp = max(0.0, min(float(temperature), 2.0))
    clamped_tokens = max(1, int(max_output_tokens))

    messages: list[LLMMessage] = [
        LLMMessage(role=LLMRole.SYSTEM, content=system_prompt),
    ]

    history_list = list(history) if history else []
    cleaned_user_msg = user_message.strip()

    # Defensive check: drop trailing duplicate user message from history if it matches active user_message
    if history_list and history_list[-1].role == LLMRole.USER and history_list[-1].content.strip() == cleaned_user_msg:
        logger.warning(
            "history_contract_violation: trailing duplicate user turn found in history for request_id=%s. Dropping trailing history turn.",
            request_id,
            extra={
                "event": "history_contract_violation",
                "request_id": request_id,
                "user_message_length": len(cleaned_user_msg),
            },
        )
        history_list.pop()

    if history_list:
        messages.extend(history_list)

    messages.append(
        LLMMessage(
            role=LLMRole.USER,
            content=user_message,
        )
    )

    return LLMRequest(
        request_id=str(request_id or "").strip(),
        messages=messages,
        temperature=clamped_temp,
        max_output_tokens=clamped_tokens,
        metadata=dict(metadata) if metadata else {},
    )
