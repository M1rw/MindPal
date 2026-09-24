# tests/backend/intelligence/test_consolidation_lease.py - one consolidation run per person at a time
"""Audit MP-11: two runs that started together both passed the budget check,
both paid for a model call, the daily count went past its cap, and the first
to finish deleted a job the other had just re-queued."""

from __future__ import annotations

import json

from backend.domain.dynamic.policy import LoadState
from backend.domain.memory.consolidation import JOBS_COLLECTION, JOURNAL_COLLECTION, MemoryConsolidationService
from backend.infra.store.providers.memory import InMemoryStore

USER = "usr_lease"
NOW = 1_800_000_000.0


def _calm() -> LoadState:
    return LoadState(level="calm", pressure=0.0, drivers={}, pulse=None, overridden=True)


def _service(store, generate):
    return MemoryConsolidationService(store, generate_json=generate, load=_calm, clock=lambda: NOW)


def _digest(**_kwargs) -> str:
    return json.dumps({"digest": "They talked about exams.", "themes": [], "helped": []})


def test_an_overlapping_run_is_refused_and_spends_nothing() -> None:
    store = InMemoryStore()
    calls: list = []
    inner: dict = {}

    def generate(**kwargs):
        calls.append(kwargs)
        if len(calls) == 1:  # a second run starts while the first waits on the model
            inner["report"] = service.run(USER, force=True)
        return _digest()

    service = _service(store, generate)
    for i in range(6):
        service.record_turn(USER, f"exam stress again {i}", "What helps?")
    service.run(USER)
    assert inner["report"].skipped == "in_progress"
    assert store.get_document(JOURNAL_COLLECTION, USER)["lease"] is None, "released afterwards"


def test_the_daily_budget_is_reserved_before_the_model_is_called() -> None:
    store = InMemoryStore()
    service = _service(store, _digest)
    for i in range(6):
        service.record_turn(USER, f"exam stress again {i}", "What helps?")
    journal = store.get_document(JOURNAL_COLLECTION, USER)
    journal["ai_calls"] = {"day": "2027-01-15", "count": 5}  # NOW's UTC day, one call left
    store.set_document(JOURNAL_COLLECTION, USER, journal)
    report = service.run(USER)
    assert report.ai_calls == 1
    assert store.get_document(JOURNAL_COLLECTION, USER)["ai_calls"]["count"] == 6


def test_a_request_queued_during_a_run_survives_its_completion() -> None:
    store = InMemoryStore()

    def generate(**_kwargs):
        service.enqueue(USER, reason="requested")  # new work arrives mid-run
        return _digest()

    service = _service(store, generate)
    for i in range(6):
        service.record_turn(USER, f"exam stress again {i}", "What helps?")
    service.run(USER)
    assert store.get_document(JOBS_COLLECTION, USER) is not None
