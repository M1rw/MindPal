# tests/backend/intelligence/test_wellness_timeline.py — Honest mood/event reflection from stored text

from __future__ import annotations

from backend.domain.identity.identity import IdentityService
from backend.domain.memory.extract import extract_atoms_from_turn
from backend.domain.memory.graph import MemoryAtom
from backend.domain.wellness.timeline import (
    SOURCE_ACCOUNT,
    SOURCE_ACCOUNT_LABEL,
    build_wellness_timeline,
)
from backend.infra.store.store import InMemoryStore
from backend.main import create_app
from fastapi.testclient import TestClient


def test_empty_inputs_are_empty_without_fake_scores():
    payload = build_wellness_timeline(
        atoms=[],
        turns=[],
        source=SOURCE_ACCOUNT,
        source_label=SOURCE_ACCOUNT_LABEL,
    )
    blob = str(payload).lower()
    assert payload["empty"] is True
    assert payload["empty_reason"] == "no_saved_signals"
    assert payload["mood_timeline"] == []
    assert payload["activity"] == []
    assert payload["themes"] == []
    assert payload["events"] == []
    assert payload["highlights"]["heavier_day"] is None
    assert payload["highlights"]["lighter_day"] is None
    assert payload["crisis_note"] is None
    assert "phq" not in blob
    assert "gad-7" not in blob
    assert "diagnosis" not in payload["disclaimer"].lower() or "not a diagnosis" in payload["disclaimer"].lower()
    assert "clinical" not in blob


def test_mood_timeline_uses_coarse_valence_from_user_turns():
    payload = build_wellness_timeline(
        atoms=[],
        turns=[
            {"content": "I feel angry about work today.", "timestamp": "2026-09-10T10:00:00Z"},
            {"content": "I'm feeling grateful and calm this morning.", "timestamp": "2026-09-12T09:00:00Z"},
            {"content": "Work is still on my mind.", "timestamp": "2026-09-11T12:00:00Z"},
        ],
        source=SOURCE_ACCOUNT,
        source_label=SOURCE_ACCOUNT_LABEL,
    )
    assert payload["empty"] is False
    valences = {point["date"]: point["valence"] for point in payload["mood_timeline"]}
    assert valences["2026-09-10"] == "heavy"
    assert valences["2026-09-12"] == "lighter"
    assert "2026-09-11" not in valences
    activity_dates = {row["date"] for row in payload["activity"]}
    assert activity_dates == {"2026-09-10", "2026-09-11", "2026-09-12"}
    assert payload["highlights"]["heavier_day"]["date"] == "2026-09-10"
    assert payload["highlights"]["lighter_day"]["date"] == "2026-09-12"
    assert "angry" in (payload["highlights"]["heavier_day"]["snippet"] or "").lower()
    themes = {item["id"] for item in payload["themes"]}
    assert "work" in themes
    assert all(isinstance(point.get("valence"), str) for point in payload["mood_timeline"])
    assert all(point["valence"] in {"heavy", "mixed", "lighter"} for point in payload["mood_timeline"])


def test_single_mood_day_does_not_invent_worst_and_best():
    payload = build_wellness_timeline(
        atoms=[],
        turns=[{"content": "I feel sad.", "timestamp": "2026-09-08T18:00:00Z"}],
        source=SOURCE_ACCOUNT,
        source_label=SOURCE_ACCOUNT_LABEL,
    )
    assert payload["mood_timeline"][0]["valence"] == "heavy"
    assert payload["highlights"]["heavier_day"] is None
    assert payload["highlights"]["lighter_day"] is None


def test_crisis_language_is_noted_not_charted():
    payload = build_wellness_timeline(
        atoms=[],
        turns=[
            {"content": "I want to kill myself", "timestamp": "2026-09-09T01:00:00Z"},
            {"content": "I feel happy after a walk.", "timestamp": "2026-09-10T10:00:00Z"},
        ],
        source=SOURCE_ACCOUNT,
        source_label=SOURCE_ACCOUNT_LABEL,
    )
    blob = str(payload).lower()
    assert payload["crisis_note"]
    assert "kill myself" not in blob
    assert all(point["valence"] != "heavy" or "suicid" not in (point.get("snippet") or "").lower() for point in payload["mood_timeline"])
    dates = {point["date"] for point in payload["mood_timeline"]}
    assert "2026-09-09" not in dates
    assert "2026-09-10" in dates
    assert "suicid" not in blob


def test_memory_atoms_surface_themes_and_events_without_dates_required():
    payload = build_wellness_timeline(
        atoms=[
            MemoryAtom(id="patterns:sleep", category="patterns", value="Trouble sleeping", confidence=0.8),
            MemoryAtom(id="facts:event_new_job", category="facts", value="Started a new job", confidence=0.8),
        ],
        turns=[],
        source=SOURCE_ACCOUNT,
        source_label=SOURCE_ACCOUNT_LABEL,
    )
    assert payload["empty"] is False
    assert payload["mood_timeline"] == []
    theme_ids = {item["id"] for item in payload["themes"]}
    event_ids = {item["id"] for item in payload["events"]}
    assert "sleep" in theme_ids
    assert "new_job" in event_ids
    assert payload["themes"][0]["from_memory"] is True


def test_extract_persists_explicit_feeling_and_event():
    atoms = extract_atoms_from_turn("I feel angry. I just got a new job.")
    blob = " ".join(atom.value for atom in atoms).lower()
    assert "angry" in blob
    assert "new job" in blob
    assert extract_atoms_from_turn("I want to end my life. I feel sad.") == []


def test_identity_service_reads_store_and_delete_clears_it():
    store = InMemoryStore()
    identity = IdentityService()
    identity.store = store
    store.set_document(
        "memory_graphs",
        "usr_well",
        {
            "atoms": [{"id": "patterns:sleep", "category": "patterns", "value": "Trouble sleeping", "confidence": 0.8}],
        },
    )
    store.set_document(
        "chat_sessions",
        "usr_well:s1",
        {
            "id": "s1",
            "messages": [
                {"role": "user", "content": "I feel angry at work.", "timestamp": "2026-09-10T10:00:00Z"},
                {"role": "assistant", "content": "I'm here."},
                {"role": "user", "content": "I'm feeling grateful today.", "timestamp": "2026-09-13T10:00:00Z"},
            ],
        },
    )
    payload = identity.get_wellness_timeline("usr_well")
    assert payload["empty"] is False
    assert payload["source"] == SOURCE_ACCOUNT
    assert any(point["valence"] == "heavy" for point in payload["mood_timeline"])
    identity.delete_account("usr_well")
    cleared = identity.get_wellness_timeline("usr_well")
    assert cleared["empty"] is True
    assert cleared["mood_timeline"] == []
    assert cleared["themes"] == []


def test_wellness_timeline_http_requires_sign_in_and_returns_real_data():
    client = TestClient(create_app(serve_frontend=False))
    guest = client.get("/api/user/wellness-timeline")
    assert guest.status_code == 401
    assert guest.json()["code"] == "unauthenticated"

    auth = {"Authorization": "Bearer dev_wellness_empty"}
    empty = client.get("/api/user/wellness-timeline", headers=auth)
    assert empty.status_code == 200
    body = empty.json()
    assert body["empty"] is True
    assert body["mood_timeline"] == []
    assert "phq9" not in str(body).lower()
    assert "clinical" not in str(body).lower()

    filled_auth = {"Authorization": "Bearer dev_wellness_filled"}
    put = client.put(
        "/api/memory/graph",
        json={
            "atoms": [
                {"id": "patterns:sleep", "category": "patterns", "value": "Trouble sleeping", "confidence": 0.8},
            ]
        },
        headers=filled_auth,
    )
    assert put.status_code == 200
    save = client.post(
        "/api/chats",
        json={
            "id": "chat_well_1",
            "title": "Week",
            "createdAt": "2026-09-10T00:00:00Z",
            "updatedAt": "2026-09-13T00:00:00Z",
            "messages": [
                {"role": "user", "content": "I feel angry about work.", "timestamp": "2026-09-10T10:00:00Z"},
                {"role": "user", "content": "I'm happy we moved to a quieter place.", "timestamp": "2026-09-13T09:00:00Z"},
            ],
        },
        headers=filled_auth,
    )
    assert save.status_code == 200
    filled = client.get("/api/user/wellness-timeline", headers=filled_auth)
    assert filled.status_code == 200
    data = filled.json()
    assert data["empty"] is False
    assert data["source"] == SOURCE_ACCOUNT
    assert any(point["valence"] == "heavy" for point in data["mood_timeline"])
    assert any(point["valence"] == "lighter" for point in data["mood_timeline"])
    assert any(theme["id"] == "sleep" for theme in data["themes"])
    assert any(theme["id"] == "work" for theme in data["themes"])
    assert any(event["id"] == "moved" for event in data["events"])
    assert data["highlights"]["heavier_day"] is not None
    assert data["highlights"]["lighter_day"] is not None

    deleted = client.delete("/api/user/data", headers=filled_auth)
    assert deleted.status_code == 200
    after = client.get("/api/user/wellness-timeline", headers=filled_auth)
    assert after.status_code == 200
    assert after.json()["empty"] is True
    assert after.json()["themes"] == []


def test_wellness_timeline_corrupt_graph_is_empty_not_500():
    client = TestClient(create_app(serve_frontend=False))
    from backend.http.identity import identity_service

    identity_service.store.set_document(
        "memory_graphs",
        "usr_wellness_corrupt",
        {"atoms": "not-a-list"},
    )
    res = client.get(
        "/api/user/wellness-timeline",
        headers={"Authorization": "Bearer dev_wellness_corrupt"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["empty"] is True
    assert body["mood_timeline"] == []
    assert "phq" not in str(body).lower()
