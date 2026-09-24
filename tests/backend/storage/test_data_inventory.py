# tests/backend/storage/test_data_inventory.py - export and deletion follow one inventory
"""Audit MP-15: export and deletion were hand-maintained lists. Personalised
greetings survived deletion and were never exported; raw journal turns were
counted in the export but not included. Every collection in
backend/domain/identity/inventory.py is seeded here for two accounts, and its
declared export/delete policy is checked against what actually happens."""

from __future__ import annotations

import json

import pytest

from backend.domain.identity.identity import IdentityService
from backend.domain.identity.inventory import INVENTORY
from backend.infra.store.providers.memory import InMemoryStore
from backend.tools.voice_retention import purge_expired_greetings

ALICE = "usr_inventory_alice"
BOB = "usr_inventory_bob"


def _doc_id(collection, user: str) -> str:
    if collection.owner_key == "id":
        return user
    if collection.owner_key == "prefix":
        return f"{user}:item"
    return f"{collection.name}_{user}_1"


def _seed(store: InMemoryStore, collection, user: str) -> None:
    marker = f"MARK-{collection.name}-{user}"
    doc = {"user_id_hash": user, "marker": marker, "session_id": f"vs_{user}"}
    if collection.name == "memory_journal":
        doc.update({"turns": [{"user": marker, "reply": "ok", "at": 1.0}], "digests": []})
    if collection.name == "memory_graphs":
        doc.update({"atoms": [{"id": "facts:m", "category": "facts", "value": marker}]})
    if collection.name == "chat_sessions":
        doc.update({"id": "item", "messages": [{"role": "user", "content": marker}]})
    if collection.name == "voice_sessions":
        doc.update({"summary_text": marker})
    if collection.name == "voice_telemetry":
        doc.update({"event": "voice.session.mint", "reason": marker})
    if collection.name == "voice_support_diagnostics":
        doc.update({"report": {"note": marker}})
    if collection.name == "adaptive_profiles":
        doc.update({"note": marker})
    store.set_document(collection.name, _doc_id(collection, user), doc)


@pytest.fixture()
def seeded():
    store = InMemoryStore()
    for collection in INVENTORY:
        _seed(store, collection, ALICE)
        _seed(store, collection, BOB)
    identity = IdentityService()
    identity.store = store
    return store, identity


@pytest.mark.parametrize("collection", [c for c in INVENTORY if c.export == "yes"], ids=lambda c: c.name)
def test_exported_collections_appear_in_the_export(seeded, collection) -> None:
    store, identity = seeded
    exported = json.dumps(identity.export_data(ALICE), default=str)
    if collection.name == "adaptive_profiles":
        pytest.skip("exported as a derived description, not the raw row")
    assert f"MARK-{collection.name}-{ALICE}" in exported
    assert f"MARK-{collection.name}-{BOB}" not in exported


@pytest.mark.parametrize("collection", INVENTORY, ids=lambda c: c.name)
def test_deletion_follows_the_inventory(seeded, collection) -> None:
    store, identity = seeded
    identity.delete_account(ALICE)
    alice_left = store.get_document(collection.name, _doc_id(collection, ALICE))
    if collection.delete == "yes":
        assert alice_left is None, f"{collection.name} survived account deletion"
    else:
        assert alice_left is not None, f"{collection.name} should be kept: {collection.delete}"
    assert store.get_document(collection.name, _doc_id(collection, BOB)) is not None, "another account was touched"


def test_greetings_expire_and_are_purged_by_the_daily_job() -> None:
    store = InMemoryStore()
    store.set_document("greeting_cache", f"{ALICE}:2026-09-20:morning", {"greeting": "Hi", "expires_at": 100.0})
    store.set_document("greeting_cache", f"{ALICE}:2026-09-23:morning", {"greeting": "Hi", "expires_at": 10_000.0})
    store.set_document("greeting_cache", f"{BOB}:legacy", {"greeting": "Hi"})  # written before expiry existed
    assert purge_expired_greetings(store, now=5_000.0) == 2
    assert [doc_id for doc_id, _ in store.iter_documents("greeting_cache")] == [f"{ALICE}:2026-09-23:morning"]
