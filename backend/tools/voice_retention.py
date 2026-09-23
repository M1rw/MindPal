from __future__ import annotations

from typing import Any

from backend.domain.voice.privacy import VoicePrivacyService
from backend.infra.store.store import get_store


def run_voice_retention(*, store: Any | None = None) -> dict[str, int]:
    """Run from a deployment scheduler; safe to retry and safe on serverless."""
    return VoicePrivacyService(store or get_store()).purge_expired()


if __name__ == "__main__":
    print(run_voice_retention())
