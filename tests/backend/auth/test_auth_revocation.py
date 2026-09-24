# tests/backend/auth/test_auth_revocation.py
#
# Revocation checking costs a call to Firebase on every request. Turning it on
# naively means a network blip at the identity provider signs everybody out, so
# "this token is revoked" and "we could not find out" must not share an outcome.

from __future__ import annotations

import pytest
from firebase_admin import auth

from backend.core.errors import AppError
from backend.infra.auth.verifier import AuthVerifier


class _FakeAuth:
    """Stands in for firebase_admin.auth with a scripted second call."""

    RevokedIdTokenError = auth.RevokedIdTokenError
    UserDisabledError = auth.UserDisabledError
    ExpiredIdTokenError = auth.ExpiredIdTokenError

    def __init__(self, *, local_ok: bool = True, revoked_error: Exception | None = None) -> None:
        self.local_ok = local_ok
        self.revoked_error = revoked_error
        self.calls: list[bool] = []

    def verify_id_token(self, token, app=None, check_revoked=False):
        self.calls.append(check_revoked)
        if not self.local_ok:
            raise auth.InvalidIdTokenError("bad signature")
        if check_revoked and self.revoked_error is not None:
            raise self.revoked_error
        return {"uid": "abc123", "email": "a@example.com", "firebase": {"sign_in_provider": "google.com"}}


@pytest.fixture
def patched(monkeypatch):
    """Route the verifier's local imports at a scripted auth module."""
    import firebase_admin

    def install(fake: _FakeAuth):
        monkeypatch.setattr(firebase_admin, "_apps", {}, raising=False)
        # Verification now goes through the shared Firebase Admin app.
        monkeypatch.setattr("backend.infra.firebase.app.get_firebase_app", lambda: object())
        monkeypatch.setattr("firebase_admin.auth.verify_id_token", fake.verify_id_token)
        monkeypatch.setattr("firebase_admin.auth.RevokedIdTokenError", auth.RevokedIdTokenError)
        return fake

    return install


def test_a_revoked_token_is_refused(patched, monkeypatch) -> None:
    monkeypatch.setenv("FIREBASE_CHECK_REVOKED_TOKENS", "true")
    fake = patched(
        _FakeAuth(revoked_error=auth.RevokedIdTokenError("The Firebase ID token has been revoked."))
    )
    with pytest.raises(AppError) as exc:
        AuthVerifier().verify_authorization_header("Bearer real.looking.token")
    assert exc.value.code == "unauthenticated"
    assert fake.calls == [False, True], "local verify first, then the revocation lookup"


def test_a_disabled_account_is_refused(patched, monkeypatch) -> None:
    monkeypatch.setenv("FIREBASE_CHECK_REVOKED_TOKENS", "true")
    patched(_FakeAuth(revoked_error=auth.UserDisabledError("disabled", cause=None, http_response=None)))
    with pytest.raises(AppError):
        AuthVerifier().verify_authorization_header("Bearer real.looking.token")


def test_an_unreachable_revocation_lookup_does_not_sign_a_valid_user_out(
    patched, monkeypatch
) -> None:
    """The availability half. A timeout here is our problem, not the caller's."""
    monkeypatch.setenv("FIREBASE_CHECK_REVOKED_TOKENS", "true")
    fake = patched(_FakeAuth(revoked_error=auth.CertificateFetchError("network down", cause=None)))
    session = AuthVerifier().verify_authorization_header("Bearer real.looking.token")
    assert session.is_authenticated is True
    assert session.user_id_hash == "usr_abc123"
    assert fake.calls == [False, True]


def test_a_bad_signature_is_refused_whatever_the_revocation_setting(patched, monkeypatch) -> None:
    monkeypatch.setenv("FIREBASE_CHECK_REVOKED_TOKENS", "false")
    fake = patched(_FakeAuth(local_ok=False))
    with pytest.raises(AppError):
        AuthVerifier().verify_authorization_header("Bearer forged.token.here")
    assert fake.calls == [False], "a token that fails locally costs no network call"


def test_revocation_off_skips_the_second_lookup(patched, monkeypatch) -> None:
    monkeypatch.setenv("FIREBASE_CHECK_REVOKED_TOKENS", "false")
    fake = patched(_FakeAuth())
    session = AuthVerifier().verify_authorization_header("Bearer real.looking.token")
    assert session.is_authenticated is True
    assert fake.calls == [False]


@pytest.mark.parametrize(
    "error",
    [
        auth.UserNotFoundError("No user record found for the provided user ID."),
        auth.UserDisabledError("disabled", cause=None, http_response=None),
        auth.RevokedIdTokenError("revoked"),
        auth.InvalidIdTokenError("invalid"),
        RuntimeError("unexpected programming error"),
    ],
    ids=["deleted-user", "disabled", "revoked", "invalid", "unrecognised"],
)
def test_a_definite_or_unknown_lookup_answer_never_authenticates(patched, monkeypatch, error) -> None:
    """Audit MP-07: a user deleted in Firebase kept working until the token expired,
    because "user not found" was treated like an outage."""
    monkeypatch.setenv("FIREBASE_CHECK_REVOKED_TOKENS", "true")
    patched(_FakeAuth(revoked_error=error))
    with pytest.raises(AppError) as exc:
        AuthVerifier().verify_authorization_header("Bearer real.looking.token")
    assert exc.value.code == "unauthenticated"


@pytest.mark.parametrize(
    "error_factory",
    [
        lambda: __import__("firebase_admin").exceptions.UnavailableError("down", cause=None),
        lambda: __import__("firebase_admin").exceptions.DeadlineExceededError("slow", cause=None),
        lambda: TimeoutError("socket timed out"),
    ],
    ids=["unavailable", "deadline", "timeout"],
)
def test_only_outages_get_the_availability_grace(patched, monkeypatch, error_factory) -> None:
    monkeypatch.setenv("FIREBASE_CHECK_REVOKED_TOKENS", "true")
    patched(_FakeAuth(revoked_error=error_factory()))
    assert AuthVerifier().verify_authorization_header("Bearer real.looking.token").is_authenticated
