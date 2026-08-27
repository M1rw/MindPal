"""
Tests for favicon router security and cache key validation.
"""

import pytest
from backend.api.favicon_router import _cache_key


def test_cache_key_valid_urls():
    assert _cache_key("https://example.com/favicon.ico") == "https://example.com"
    assert _cache_key("http://SUB.DOMAIN.ORG/path?query=1") == "http://sub.domain.org"


def test_cache_key_invalid_urls_raise_value_error():
    with pytest.raises(ValueError, match="Invalid target URL origin"):
        _cache_key("relative/path/no/scheme")

    with pytest.raises(ValueError, match="Invalid target URL origin"):
        _cache_key("http://")

    with pytest.raises(ValueError, match="Invalid target URL origin"):
        _cache_key("://missing-scheme.com")


def test_is_trusted_redirect_valid_and_invalid_urls():
    from backend.api.favicon_router import _is_trusted_redirect

    # Valid redirects
    assert _is_trusted_redirect("https://www.google.com/s2/favicons?domain=example.com") is True
    assert _is_trusted_redirect("https://t0.gstatic.com/faviconV2") is True
    assert _is_trusted_redirect("https://sub.gstatic.com/path") is True

    # Invalid scheme / bypass attempts
    assert _is_trusted_redirect("http://www.google.com") is False
    assert _is_trusted_redirect("ftp://www.google.com") is False
    assert _is_trusted_redirect("//www.google.com") is False

    # Subdomain spoofing / parser trickery
    assert _is_trusted_redirect("https://google.com.attacker.com") is False
    assert _is_trusted_redirect("https://gstatic.com.attacker.com") is False
    assert _is_trusted_redirect("https://user:pass@www.google.com@attacker.com") is False
    assert _is_trusted_redirect("https://user:pass@t0.gstatic.com") is False
    assert _is_trusted_redirect("https://notgstatic.com") is False
