# tests/unit/domain/test_firebase_regression.py

from __future__ import annotations

import json
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from backend.core.config import get_settings, reset_settings
from backend.core.errors import DatabaseError
from backend.services.domain.auth.providers.firebase_provider import (
    _firebase_credentials as auth_credentials,
)
from backend.services.domain.auth.providers.firebase_provider import (
    _firebase_project_id as auth_project_id,
)
from backend.services.domain.storage.providers.firebase_provider import (
    UnavailableDBProvider,
)
from backend.services.domain.storage.providers.firebase_provider import (
    _firebase_credentials as db_credentials,
)
from backend.services.domain.storage.providers.firebase_provider import (
    _firebase_project_id as db_project_id,
)


def _generate_valid_pem_private_key() -> str:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")


def test_large_firebase_credentials_json_parsing(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ensure FIREBASE_CREDENTIALS_JSON > 1000 chars is not truncated by setting_str."""
    pem_key = _generate_valid_pem_private_key()
    dummy_data = {
        "type": "service_account",
        "project_id": "mindpal-regression-test",
        "private_key_id": "key1234567890" * 5,
        "private_key": pem_key,
        "client_email": "firebase-adminsdk@mindpal-regression-test.iam.gserviceaccount.com",
        "client_id": "123456789012345678901",
        "auth_uri": "https://accounts.google.com/o/oauth2/auth",
        "token_uri": "https://oauth2.googleapis.com/token",
        "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
        "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk%40mindpal-regression-test.iam.gserviceaccount.com",
    }
    raw_json = json.dumps(dummy_data)
    assert len(raw_json) > 1000

    monkeypatch.setenv("FIREBASE_CREDENTIALS_JSON", raw_json)
    monkeypatch.delenv("FIREBASE_PROJECT_ID", raising=False)
    monkeypatch.delenv("GOOGLE_CLOUD_PROJECT", raising=False)

    reset_settings()
    settings = get_settings()

    # Assert settings resolves project_id from credentials JSON
    assert settings.resolved_firebase_project_id == "mindpal-regression-test"

    # Assert storage provider extracts project_id and reads credentials without truncation
    assert db_project_id(settings) == "mindpal-regression-test"
    cert = db_credentials(settings, expected_project_id="mindpal-regression-test")
    assert cert is not None

    # Assert auth provider extracts project_id and reads credentials without truncation
    assert auth_project_id(settings) == "mindpal-regression-test"
    auth_cert = auth_credentials(settings, expected_project_id="mindpal-regression-test")
    assert auth_cert is not None


def test_unavailable_db_provider_error_details() -> None:
    """Assert UnavailableDBProvider raises DatabaseError with status 503 and actionable message."""
    provider = UnavailableDBProvider(reason="Missing FIREBASE_PROJECT_ID in production")
    assert not provider.is_configured

    with pytest.raises(DatabaseError) as exc_info:
        err = provider._error("set_document")
        raise err

    exc = exc_info.value
    assert exc.status_code == 503
    assert exc.code == "db_provider_unavailable"
    assert "Firebase database provider is unavailable" in str(exc)
    assert exc.details["operation"] == "set_document"
    assert "Missing FIREBASE_PROJECT_ID" in exc.details["reason"]


def test_anonymous_session_config_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """Assert default ALLOW_ANONYMOUS_SESSIONS settings."""
    reset_settings()
    settings = get_settings()
    assert settings.ALLOW_ANONYMOUS_SESSIONS is True


def test_production_settings_anonymous_session_combinations(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ensure production Settings initializes without raising ValidationError when ALLOW_ANONYMOUS_SESSIONS is False."""
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("ALLOW_ANONYMOUS_SESSIONS", "false")
    monkeypatch.setenv("ENABLE_OFFLINE_LLM_FALLBACK", "true")

    reset_settings()
    settings = get_settings()

    assert settings.is_production is True
    assert settings.ALLOW_ANONYMOUS_SESSIONS is False
    assert settings.REQUIRE_AUTH_FOR_PROVIDER_CALLS is True
