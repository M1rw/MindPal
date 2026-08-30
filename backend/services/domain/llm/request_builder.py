# backend/services/domain/llm/request_builder.py

from __future__ import annotations

from collections.abc import Sequence
from backend.models.chat import LLMMessage, LLMRequest, LLMRole


def build_llm_request(
    *,
    request_id: str,
    system_prompt: str,
    user_message: str,
    history: Sequence[LLMMessage] | None = None,
    temperature: float = 0.4,
    max_output_tokens: int = 700,
    metadata: dict[str, str | int | float | bool | None] | None = None,
) -> LLMRequest:
    """
    Build an LLMRequest with a guaranteed system message.
    """
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
        request_id=request_id,
        messages=messages,
        temperature=temperature,
        max_output_tokens=max_output_tokens,
        metadata=metadata or {},
    )
