# backend/services/domain/llm/protocols.py

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable
from backend.models.chat import LLMRequest, LLMResponse


@runtime_checkable
class LLMProvider(Protocol):
    """Provider protocol used by LLMService."""

    name: str

    @property
    def is_configured(self) -> bool:
        ...

    async def generate(self, request: LLMRequest) -> LLMResponse:
        ...

    async def generate_stream(self, request: LLMRequest) -> Any:
        ...

    async def embed(self, texts: list[str]) -> list[list[float]]:
        ...
