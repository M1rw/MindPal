# backend/services/domain/llm/request_builder.py

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from backend.models.chat import LLMMessage, LLMRequest, LLMRole


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

    if history:
        messages.extend(history)

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
