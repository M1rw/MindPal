"""Scheduled and operator-facing work, kept out of the HTTP layer."""

from __future__ import annotations

from typing import Any

from backend.domain.dynamic.policy import current_load
from backend.domain.memory.consolidation import MemoryConsolidationService
from backend.infra.observability.pulse import platform_pulse, purge_old_pulse


def run_scheduled_consolidation(consolidation: MemoryConsolidationService) -> dict[str, Any]:
    """The scheduler tick: consolidate queued memory within the load policy, then prune pulse data."""
    result = consolidation.run_due()
    result["pulse_purged"] = purge_old_pulse(consolidation.store)
    return result


def platform_status() -> dict[str, Any]:
    """Current load level, its drivers, and the merged platform pulse."""
    platform_pulse().flush()
    return current_load().as_dict()


def run_voice_retention_sweep() -> int:
    """The voice retention sweep, for the daily scheduler endpoint."""
    from backend.tools.voice_retention import run_voice_retention

    return run_voice_retention()
