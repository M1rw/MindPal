import re
import hashlib
import uuid
from typing import Literal

def generate_request_id() -> str:
    """Generate a unique request identifier."""
    return str(uuid.uuid4())

def hash_user_id(user_id: str) -> str:
    """Hash the user ID securely to avoid logging or exposing raw PII."""
    return hashlib.sha256(user_id.encode('utf-8')).hexdigest()

def safe_truncate(text: str, max_chars: int) -> str:
    """Truncate text safely to max_chars."""
    if not text:
        return ""
    return text[:max_chars]

def sanitize_text(text: str, max_chars: int) -> str:
    """Sanitize the input text and truncate. Preserves Arabic and other unicode."""
    if not text:
        return ""
    # Strip excessive leading/trailing whitespace
    clean_text = text.strip()
    return safe_truncate(clean_text, max_chars)

def normalize_locale(locale: str | None) -> Literal["en", "ar", "auto"]:
    """Normalize locale string safely."""
    if not locale:
        return "auto"
    norm = locale.lower()[:2]
    if norm == "ar":
        return "ar"
    if norm == "en":
        return "en"
    return "auto"

def redact_basic_pii(text: str) -> str:
    """
    Redacts obvious PII such as emails, phone numbers, and Bearer/API keys.
    This is a basic pass, robust NLP methods belong in the redaction service.
    """
    if not text:
        return ""
    
    # Redact email addresses
    email_pattern = r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b"
    text = re.sub(email_pattern, "[EMAIL_REDACTED]", text)
    
    # Redact phone-like numbers (simple heuristic: 8+ digits, possible '+' or spaces/dashes)
    phone_pattern = r"(?:\+?\d{1,3}[-. ]?)?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}\b"
    text = re.sub(phone_pattern, "[PHONE_REDACTED]", text)
    
    # Redact explicit Bearer tokens or API Keys
    bearer_pattern = r"(?i)bearer\s+[a-z0-9\-\._~+]+"
    text = re.sub(bearer_pattern, "Bearer [TOKEN_REDACTED]", text)
    
    return text