from backend.core.security import generate_request_id, hash_user_id, sanitize_text, normalize_locale, redact_basic_pii

def test_generate_request_id():
    req1 = generate_request_id()
    req2 = generate_request_id()
    assert req1 != req2
    assert len(req1) > 10

def test_hash_user_id():
    user = "some_user_123"
    hashed = hash_user_id(user)
    assert hashed != user
    assert len(hashed) == 64
    assert hash_user_id(user) == hashed

def test_sanitize_text():
    text = "  hello world  "
    sanitized = sanitize_text(text, 5)
    assert sanitized == "hello"

def test_sanitize_arabic_text():
    text = "مرحبا بك"
    sanitized = sanitize_text(text, 10)
    assert sanitized == "مرحبا بك"

def test_normalize_locale():
    assert normalize_locale("en-US") == "en"
    assert normalize_locale("ar-SA") == "ar"
    assert normalize_locale(None) == "auto"
    assert normalize_locale("fr") == "auto"

def test_redact_basic_pii():
    text = "Contact me at user@example.com or +1 800 555 1234 with Bearer xyz123"
    redacted = redact_basic_pii(text)
    assert "user@example.com" not in redacted
    assert "[EMAIL_REDACTED]" in redacted
    assert "+1 800 555 1234" not in redacted
    assert "[PHONE_REDACTED]" in redacted
    assert "xyz123" not in redacted
    assert "Bearer [TOKEN_REDACTED]" in redacted
