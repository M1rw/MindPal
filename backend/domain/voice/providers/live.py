from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


@dataclass(frozen=True, slots=True)
class LiveVoiceCapabilities:
    native_audio: bool
    input_transcription: bool
    output_transcription: bool
    session_resumption: bool
    proactivity: bool
    compression: bool
    safety_settings: bool
    voices: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class LiveVoiceHealth:
    provider: str
    status: str
    circuit: str
    latency_ms: int = 0
    last_failure: str = ""
    fallback_eligible: bool = False


class LiveVoiceProvider(Protocol):
    name: str

    def capabilities(self) -> LiveVoiceCapabilities:
        ...

    def health(self) -> LiveVoiceHealth:
        ...

    def mint(self, **kwargs: Any) -> dict[str, Any]:
        ...


class LiveVoiceCircuit:
    def __init__(self, *, failure_threshold: int = 3, cooldown_s: float = 30.0) -> None:
        self.failure_threshold = failure_threshold
        self.cooldown_s = cooldown_s
        self.failures = 0
        self.opened_at = 0.0
        self.last_failure = ""

    def allow(self, now: float) -> bool:
        return self.opened_at <= 0 or now - self.opened_at >= self.cooldown_s

    def success(self) -> None:
        self.failures = 0
        self.opened_at = 0.0
        self.last_failure = ""

    def failure(self, reason: str, now: float) -> None:
        self.failures += 1
        self.last_failure = reason[:160]
        if self.failures >= self.failure_threshold:
            self.opened_at = now


class LiveVoiceProviderRouter:
    """Select a healthy provider and fall back in declared priority order."""

    def __init__(self, providers: tuple[LiveVoiceProvider, ...]) -> None:
        if not providers:
            raise ValueError("At least one live voice provider is required")
        self.providers = providers
        self.last_provider = providers[0].name

    def capabilities(self) -> LiveVoiceCapabilities:
        return self.providers[0].capabilities()

    def health(self) -> LiveVoiceHealth:
        health = [provider.health() for provider in self.providers]
        for item in health:
            if item.status == "healthy" and item.circuit != "open":
                return item
        return health[0]

    def mint(self, **kwargs: Any) -> dict[str, Any]:
        last_error: Exception | None = None
        for provider in self.providers:
            health = provider.health()
            if health.circuit == "open":
                continue
            try:
                result = provider.mint(**kwargs)
                self.last_provider = provider.name
                return result
            except Exception as exc:
                last_error = exc
        if last_error:
            raise last_error
        raise RuntimeError("No live voice provider is healthy")
