from __future__ import annotations

from backend.core.security import sanitize_text, generate_request_id, normalize_locale


def test_sanitize_text():
    raw = "  Hello \x00 World!  "
    sanitized = sanitize_text(raw, max_chars=20)
    assert "Hello" in sanitized
    assert len(sanitized) <= 20


def test_generate_request_id():
    req_id = generate_request_id()
    assert isinstance(req_id, str)
    assert len(req_id) > 0


def test_normalize_locale():
    assert normalize_locale("en-US") == "en"
    assert normalize_locale("ar") == "ar"
    assert normalize_locale("unknown-locale") == "auto"
