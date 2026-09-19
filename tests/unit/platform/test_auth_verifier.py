# tests/unit/platform/test_auth_verifier.py — production auth is fail-closed

from __future__ import annotations

import pytest

from backend.core.errors import AppError
from backend.infra.auth.verifier import (
    AuthVerifier,
    allows_dev_auth_bypass,
    check_revoked_tokens,
    runtime_environment,
)


def _refuses(header: str) -> AppError:
    with pytest.raises(AppError) as excinfo:
        AuthVerifier().verify_authorization_header(header)
    assert excinfo.value.code == "unauthenticated"
    return excinfo.value


def test_dev_tokens_authenticate_only_in_non_prod(monkeypatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "test")
    assert allows_dev_auth_bypass() is True
    session = AuthVerifier().verify_authorization_header("Bearer dev_voiceuser")
    assert session.is_authenticated is True
    assert session.user_id_hash == "usr_voiceuser"
    assert session.has_account_storage is True

    monkeypatch.setenv("ENVIRONMENT", "development")
    session = AuthVerifier().verify_authorization_header("Bearer test_local")
    assert session.is_authenticated is True


def test_production_refuses_dev_and_test_bearers(monkeypatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "production")
    assert runtime_environment() == "production"
    assert allows_dev_auth_bypass() is False
    for token in ("dev_attacker", "test_attacker", "mock_token"):
        _refuses(f"Bearer {token}")


def test_unset_environment_is_production_fail_closed(monkeypatch) -> None:
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    _refuses("Bearer dev_should_not_work")


def test_failed_firebase_verify_is_refused_not_downgraded(monkeypatch) -> None:
    """A credential that does not verify is a 401, never a guest session.

    Downgrading it to anonymous is what made every forged, expired or revoked
    token a silent write to the shared guest bucket instead of an error the
    client already knows how to retry with a fresh token.
    """
    monkeypatch.setenv("ENVIRONMENT", "production")
    _refuses("Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.fake")


def test_failed_firebase_verify_fail_closed_in_test_too(monkeypatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "test")
    _refuses("Bearer not-a-dev-prefix-token")


def test_malformed_authorization_header_is_refused() -> None:
    for header in ("NotBearer token", "Bearer", "Bearer a b", "token-without-scheme"):
        _refuses(header)


def test_absent_credential_is_a_keyless_guest() -> None:
    """No header is not an error — it is a visitor with no server-side storage."""
    for header in (None, "", "   "):
        session = AuthVerifier().verify_authorization_header(header)
        assert session.is_authenticated is False
        assert session.provider == "anonymous"
        # The critical property: guests share no durable identity, so no route
        # can address one guest's stored data on behalf of another.
        assert session.user_id_hash == ""
        assert session.has_account_storage is False


def test_guest_is_refused_when_anonymous_is_not_allowed() -> None:
    with pytest.raises(AppError) as excinfo:
        AuthVerifier(allow_anonymous=False).verify_authorization_header(None)
    assert excinfo.value.code == "unauthenticated"


def test_revocation_check_defaults_on(monkeypatch) -> None:
    """A signed-out or disabled account must stop working at the next request,
    not whenever its ID token happens to expire."""
    monkeypatch.delenv("FIREBASE_CHECK_REVOKED_TOKENS", raising=False)
    assert check_revoked_tokens() is True
    monkeypatch.setenv("FIREBASE_CHECK_REVOKED_TOKENS", "false")
    assert check_revoked_tokens() is False
    monkeypatch.setenv("FIREBASE_CHECK_REVOKED_TOKENS", "true")
    assert check_revoked_tokens() is True
