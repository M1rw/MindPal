# tests/backend/api/test_chat_session_contract.py - saved chats keep what the client relies on
"""Audit MP-12: saving a chat kept only role/content/timestamp, so message ids,
voice receipts (kind, voice_used_s) and a renamed chat's title lock were lost
on reload or on another device. Arbitrary extra fields are still dropped."""

from __future__ import annotations

from backend.domain.sessions.contracts import ChatSessionPayload, clipped_messages


def test_supported_message_fields_survive_a_save() -> None:
    saved = clipped_messages([
        {"id": "m-1", "role": "user", "content": "hi", "timestamp": "2026-09-20T10:00:00Z"},
        {"id": "voice-vs_1", "role": "assistant", "content": "You talked about work.",
         "kind": "voice_receipt", "voice_used_s": 95, "strategy_used": "Active Listen", "model": "pro"},
    ])
    assert saved[0]["id"] == "m-1"
    assert saved[1] == {
        "role": "assistant", "content": "You talked about work.", "id": "voice-vs_1",
        "kind": "voice_receipt", "voice_used_s": 95, "strategy_used": "Active Listen", "model": "pro",
    }


def test_unknown_or_unsafe_fields_are_still_dropped() -> None:
    saved = clipped_messages([
        {"id": "<script>", "role": "user", "content": "x", "kind": "admin", "voice_used_s": 10,
         "model": "gpt-9", "memoryReceipt": {"saved": []}, "anything": "else"},
    ])
    assert saved == [{"role": "user", "content": "x"}]


def test_title_lock_is_part_of_the_saved_session() -> None:
    payload = ChatSessionPayload(id="s1", title="Renamed", createdAt="2026-09-20T10:00:00Z", titleLocked=True, messages=[])
    assert payload.titleLocked is True
    assert ChatSessionPayload(id="s2", createdAt="2026-09-20T10:00:00Z").titleLocked is False
