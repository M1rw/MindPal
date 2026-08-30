from __future__ import annotations

import pytest

from backend.core.errors import InputTooLongError, ValidationAppError
from backend.core.validation import validate_chat_payload, validate_quota_request, validate_text


def test_validate_text_rejects_empty_message():
    with pytest.raises(ValidationAppError):
        validate_text("", field_name="message")


def test_validate_text_rejects_overlong_input():
    with pytest.raises(InputTooLongError):
        validate_text("x" * 5000, field_name="message", max_chars=32)


def test_validate_quota_request_enforces_positive_costs():
    with pytest.raises(ValidationAppError):
        validate_quota_request(user_id_hash="user-123", request_id="req-abc", cost=0, operation="chat")


def test_validate_chat_payload_checks_history_lengths():
    payload = {
        "message": "Hello world",
        "history": [{"role": "user", "content": "ok"}] * 101,
    }

    with pytest.raises(ValidationAppError):
        validate_chat_payload(payload)
