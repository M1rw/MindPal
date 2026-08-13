from __future__ import annotations

import json

import pytest

from backend.api.chat_stream_router import _stream_replay_response


async def _read_body(response: object) -> str:
    chunks: list[str] = []
    async for chunk in response.body_iterator:  # type: ignore[attr-defined]
        chunks.append(chunk.decode("utf-8") if isinstance(chunk, bytes) else str(chunk))
    return "".join(chunks)


@pytest.mark.asyncio
async def test_completed_stream_replays_the_original_safe_reply_and_metadata() -> None:
    record = {
        "reply": "A complete, safe reply.",
        "metadata": {
            "type": "metadata",
            "request_id": "original-request",
            "provider_used": "test-provider",
            "safety": {"level": "safe", "bypass_llm": False, "matched_rules": [], "user_visible_category": "general_support"},
            "rag_used": [],
            "memory_updated": False,
        },
    }

    response = _stream_replay_response(record)

    assert response is not None
    body = await _read_body(response)
    events = [json.loads(line[5:]) for line in body.splitlines() if line.startswith("data:")]
    assert "".join(event.get("text", "") for event in events) == "A complete, safe reply."
    assert {event.get("status") for event in events if event.get("type") == "status"} == {"text_finished"}
    metadata = next(event for event in events if event.get("type") == "metadata")
    assert metadata["request_id"] == "original-request"
    assert metadata["provider_used"] == "test-provider"


def test_completed_stream_without_a_replayable_reply_is_not_replayed() -> None:
    assert _stream_replay_response({"type": "metadata", "request_id": "legacy"}) is None
