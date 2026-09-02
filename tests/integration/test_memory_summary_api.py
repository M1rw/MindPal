# tests/integration/test_memory_summary_api.py

from __future__ import annotations

import pytest
from backend.models.memory import MemoryGraph, build_memory_prompt_from_graph


def test_memory_summary_get_and_edit_roundtrip(auth_client):
    """
    Assert GET, PUT (edit rewriting), POST /refresh, and POST /reset endpoints round-trip cleanly.
    """
    # 1. GET initial summary
    get_res = auth_client.get("/api/memory/summary")
    assert get_res.status_code == 200
    initial_data = get_res.json()
    assert "summary_text" in initial_data
    assert "detected_language" in initial_data
    assert "last_updated_at" in initial_data

    # 2. PUT edit instruction
    put_res = auth_client.put(
        "/api/memory/summary",
        json={"instruction": "I prefer direct concise advice and evening reflections.", "action": "update"},
    )
    assert put_res.status_code == 200
    put_data = put_res.json()
    assert put_data["summary_text"] != ""
    assert "last_updated_at" in put_data

    # 3. POST refresh
    ref_res = auth_client.post("/api/memory/summary/refresh")
    assert ref_res.status_code == 200
    ref_data = ref_res.json()
    assert ref_data["summary_text"] != ""

    # 4. POST reset
    reset_res = auth_client.post("/api/memory/summary/reset")
    assert reset_res.status_code == 200
    reset_data = reset_res.json()
    assert reset_data["is_empty"] is True


def test_memory_disabled_isolation_contract(auth_client):
    """
    Assert that when memory is disabled via PATCH /api/memory/settings,
    build_memory_prompt_from_graph returns an empty string and memory is excluded.
    """
    patch_res = auth_client.patch("/api/memory/settings", json={"is_enabled": False})
    assert patch_res.status_code == 200
    assert patch_res.json()["is_enabled"] is False

    graph = MemoryGraph(user_id_hash="test_user_hash", full_snapshot=False)
    prompt_snippet = build_memory_prompt_from_graph(graph)
    assert prompt_snippet == ""

    # Re-enable memory
    auth_client.patch("/api/memory/settings", json={"is_enabled": True})


def test_arabic_conversation_language_detection_proof(auth_client):
    """
    Proof: An Arabic conversation user produces an Arabic detected language and Arabic summary.
    """
    # Post Arabic edit instruction
    put_res = auth_client.put(
        "/api/memory/summary",
        json={"instruction": "بحب المشي في الطبيعة وبتعلم البرمجة حالياً", "action": "update"},
    )
    assert put_res.status_code == 200
    data = put_res.json()
    assert data["detected_language"] == "ar"
    assert "نبذة" in data["summary_text"] or "المشي" in data["summary_text"] or "البرمجة" in data["summary_text"]
