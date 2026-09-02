from __future__ import annotations

import pytest
from backend.core.security import sanitize_text, generate_request_id, normalize_locale, is_safe_url, validate_url


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


def test_site_local_ipv6_url_validation():
    site_local_url = "http://[fec0::1]/admin"
    assert not is_safe_url(site_local_url)
    with pytest.raises(ValueError, match="not globally routable"):
        validate_url(site_local_url)
