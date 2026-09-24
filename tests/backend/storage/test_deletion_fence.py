# tests/backend/storage/test_deletion_fence.py - work in flight cannot bring deleted data back
"""Audit MP-06: a consolidation (or chat turn) paused on its model call when the
account's data was deleted wrote its results afterwards, recreating the
journal and memory the person had just been told were gone."""

from __future__ import annotations

import json
import time

from backend.domain.dynamic.policy import LoadState
from backend.domain.identity.fence import deleted_since, mark_deleted
from backend.domain.identity.identity import IdentityService
from backend.domain.memory.consolidation import JOURNAL_COLLECTION, MemoryConsolidationService
from backend.infra.store.providers.memory import InMemoryStore

USER = "usr_fence"


def _calm() -> LoadState:
    return LoadState(level="calm", pressure=0.0, drivers={}, pulse=None, overridden=True)


def test_the_fence_only_refuses_work_that_started_before_the_deletion() -> None:
    store = InMemoryStore()
    started = time.time()
    assert deleted_since(store, USER, started) is False
    mark_deleted(store, USER, now=started + 1)
    assert deleted_since(store, USER, started) is True, "older work is fenced"
    assert deleted_since(store, USER, started + 2) is False, "new activity after deletion writes normally"


def test_a_consolidation_waiting_on_the_model_writes_nothing_after_deletion() -> None:
    store = InMemoryStore()
    identity = IdentityService()
    identity.store = store

    def generate(**_kwargs) -> str:
        identity.delete_account(USER)  # "delete my data" while the model is working
        return json.dumps({"digest": "They talked about exams and their sister Noor.", "themes": [], "helped": [],
                           "facts": [{"category": "people", "value": "Sister is Noor"}]})

    service = MemoryConsolidationService(store, generate_json=generate, load=_calm)
    for i in range(6):
        service.record_turn(USER, f"exam stress again {i}", "What helps?")
    service.run(USER)

    assert store.get_document(JOURNAL_COLLECTION, USER) is None, "the journal came back after deletion"
    assert store.get_document("memory_graphs", USER) is None
