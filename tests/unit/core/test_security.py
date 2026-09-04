from __future__ import annotations

import pytest
from backend.core.security import (
    sanitize_text,
    generate_request_id,
    hash_user_id,
    normalize_locale,
    redact_basic_pii,
    is_safe_url,
    validate_url,
    REDACTED_SECRET,
)


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


def test_redact_basic_pii_preserves_system_identifiers():
    user_hash = hash_user_id("test_user_123")
    request_id = generate_request_id()
    msg_id = "msg_003c631e8e504767a73f2cb0046882a9"

    text = f"User {user_hash} in {request_id} sent {msg_id}"
    redacted = redact_basic_pii(text)

    assert user_hash in redacted
    assert request_id in redacted
    assert msg_id in redacted
    assert REDACTED_SECRET not in redacted


def test_redact_basic_pii_redacts_long_secrets():
    secret_token = "secret_token_abcdef12345678901234"
    text = f"Bearer token: {secret_token}"
    redacted = redact_basic_pii(text)

    assert secret_token not in redacted
    assert REDACTED_SECRET in redacted


def test_multicast_and_reserved_ip_url_validation():
    multicast_and_reserved_urls = [
        "http://224.0.0.1/admin",
        "http://[ff02::1]/status",
        "http://[ff05::1]/metrics",
        "http://[::ffff:224.0.0.1]/data",
        "http://[64:ff9b::224.0.0.1]/config",
        "http://[::224.0.0.1]/api",
    ]
    for url in multicast_and_reserved_urls:
        assert not is_safe_url(url), f"Expected unsafe URL for: {url}"
        with pytest.raises(ValueError, match="not globally routable"):
            validate_url(url)
