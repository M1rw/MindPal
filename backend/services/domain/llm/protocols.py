# backend/services/domain/llm/protocols.py

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any, Protocol, TypeAlias, runtime_checkable

from backend.models.chat import LLMRequest, LLMResponse

LLMStreamChunk: TypeAlias = str
LLMStreamResult: TypeAlias = AsyncIterator[LLMStreamChunk] | Any
EmbeddingVector: TypeAlias = list[float]


@runtime_checkable
class LLMProvider(Protocol):
    """
    Protocol defining contract for LLM provider implementations.

    All LLM providers integrated into the system must conform to this interface,
    providing text generation, streaming, and embedding capabilities.
    """

    name: str

    @property
    def is_configured(self) -> bool:
        """Indicate whether the provider has valid credentials and config."""
        ...

    async def generate(self, request: LLMRequest) -> LLMResponse:
        """Generate a complete text completion given an LLMRequest."""
        ...

    async def generate_stream(self, request: LLMRequest) -> LLMStreamResult:
        """Generate a streaming text completion yielding content chunks."""
        ...

    async def embed(self, texts: list[str]) -> list[EmbeddingVector]:
        """Generate dense vector embeddings for input text strings."""
        ...
