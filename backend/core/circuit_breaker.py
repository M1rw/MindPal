from __future__ import annotations

import logging
import time

logger = logging.getLogger(__name__)

_CIRCUIT_BREAKER_TTL_SECONDS = 60.0
_provider_failures: dict[str, float] = {}


def circuit_open(provider_name: str) -> bool:
    """Return whether a provider is temporarily excluded after a hard failure."""
    clean = str(provider_name or "").strip().lower()
    failed_at = _provider_failures.get(clean)
    if failed_at is None:
        return False
    if time.monotonic() - failed_at >= _CIRCUIT_BREAKER_TTL_SECONDS:
        _provider_failures.pop(clean, None)
        return False
    return True


def trip_circuit(provider_name: str) -> None:
    """Open a provider circuit for a bounded cool-down period."""
    clean = str(provider_name or "").strip().lower()
    if not clean:
        return
    _provider_failures[clean] = time.monotonic()
    logger.info(
        "Provider circuit opened provider=%s cooldown_seconds=%d",
        clean,
        int(_CIRCUIT_BREAKER_TTL_SECONDS),
    )


def reset_circuits_for_tests() -> None:
    _provider_failures.clear()
