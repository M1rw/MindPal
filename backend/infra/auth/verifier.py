# backend/infra/auth/verifier.py — Firebase Bearer Auth & Session Verifier

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

from backend.core.errors import AppError
from backend.configs.settings import get_settings

logger = logging.getLogger("mindpal.auth")

# Explicit non-prod runtimes that may mint synthetic bearers for tests and local
# work. Production and unknown values fail closed — including the default when
# ENVIRONMENT is unset (Vercel and main.py treat that as production).
_DEV_AUTH_ENVS = frozenset({"development", "dev", "test", "testing", "local"})

# A guest is a request with no credential at all. It deliberately carries an
# EMPTY user key rather than a shared synthetic id: every durable collection is
# keyed on `user_id_hash`, so a shared guest key made chats, profile, insights
# and memory a single cross-tenant bucket that any visitor could read, overwrite
# or delete. Guest state belongs on the guest's own device.
GUEST_USER_KEY = ""

_INVALID_CREDENTIAL_MESSAGE = (
    "Your session has expired or the sign-in token is not valid. Sign in again to continue."
)


def runtime_environment() -> str:
    return get_settings().environment.strip().lower() or "production"


def allows_dev_auth_bypass() -> bool:
    """dev_ / test_ / mock_token bearers are never production credentials."""
    return runtime_environment() in _DEV_AUTH_ENVS


def check_revoked_tokens() -> bool:
    """Default ON. A signed-out, disabled or compromised account must stop working
    at the next request, not whenever the ID token happens to expire."""
    return get_settings().firebase_check_revoked_tokens


@dataclass(frozen=True, slots=True)
class UserSession:
    user_id_hash: str
    raw_user_id: str
    is_authenticated: bool
    email: Optional[str] = None
    provider: str = "anonymous"

    @property
    def has_account_storage(self) -> bool:
        """True only for a verified account with a real per-user storage key."""
        return self.is_authenticated and bool(self.user_id_hash)


def guest_session() -> UserSession:
    return UserSession(
        user_id_hash=GUEST_USER_KEY,
        raw_user_id="",
        is_authenticated=False,
        provider="anonymous",
    )


def _is_transient_lookup_failure(exc: Exception) -> bool:
    """True only for "could not ask", never for "asked and was told no"."""
    from firebase_admin import auth, exceptions

    if isinstance(exc, (auth.CertificateFetchError,)):
        return True
    if isinstance(exc, (auth.UserNotFoundError, auth.RevokedIdTokenError, auth.UserDisabledError,
                        auth.ExpiredIdTokenError, auth.InvalidIdTokenError)):
        return False
    if isinstance(exc, (exceptions.UnavailableError, exceptions.DeadlineExceededError,
                        exceptions.InternalError, exceptions.UnknownError)):
        return True
    return isinstance(exc, (TimeoutError, ConnectionError))


class AuthVerifier:
    """Authentication verifier for HTTP requests with cryptographic RS256 Firebase Admin validation.

    Three outcomes, never two:

      * no ``Authorization`` header      -> guest session, no durable identity
      * a header that does not verify    -> ``unauthenticated`` (HTTP 401)
      * a header that verifies           -> the account it names

    The middle case used to fall through to the guest session. That turned every
    malformed, forged, expired or revoked credential into a silent write to the
    shared guest bucket instead of the 401 the client is built to retry.
    """

    def __init__(self, *, allow_anonymous: bool = True) -> None:
        self.allow_anonymous = allow_anonymous

    def verify_authorization_header(self, auth_header: Optional[str]) -> UserSession:
        if not auth_header or not auth_header.strip():
            return self._guest()

        parts = auth_header.strip().split()
        if len(parts) != 2 or parts[0].lower() != "bearer":
            logger.warning("auth_malformed_authorization_header")
            raise AppError("unauthenticated", _INVALID_CREDENTIAL_MESSAGE)

        token = parts[1]
        if token.startswith("test_") or token.startswith("dev_") or token == "mock_token":
            if not allows_dev_auth_bypass():
                logger.warning("auth_dev_bearer_refused env=%s", runtime_environment())
                raise AppError("unauthenticated", _INVALID_CREDENTIAL_MESSAGE)
            uid = token.replace("test_", "").replace("dev_", "") or "test_user"
            if uid == "mock_token":
                uid = "test_user"
            return UserSession(
                user_id_hash=f"usr_{uid}",
                raw_user_id=uid,
                is_authenticated=True,
                email=f"{uid}@example.com",
                provider="development",
            )

        decoded = self._verify_firebase_token(token)
        uid = str(decoded.get("uid") or decoded.get("sub") or "").strip()
        if not uid:
            logger.warning("auth_firebase_token_without_subject")
            raise AppError("unauthenticated", _INVALID_CREDENTIAL_MESSAGE)
        return UserSession(
            user_id_hash=f"usr_{uid}",
            raw_user_id=uid,
            is_authenticated=True,
            email=decoded.get("email"),
            provider=(decoded.get("firebase") or {}).get("sign_in_provider", "firebase"),
        )

    @staticmethod
    def _verify_firebase_token(token: str) -> dict:
        """Validate an ID token, keeping "revoked" separate from "unreachable".

        Revocation checking costs a call to Firebase on every request, so a
        network blip while it is on would reject tokens that are perfectly
        valid — signing everybody out because a lookup timed out. Signature and
        expiry are therefore verified locally first, which needs only the cached
        public keys; the revocation lookup runs as a second, separate step.

        A token that comes back revoked, expired or from a disabled account is
        refused. A revocation lookup that could not complete is logged and the
        locally verified token is accepted, because the alternative is an
        outage at the identity provider becoming an outage here.
        """
        from firebase_admin import auth

        from backend.infra.firebase.app import firebase_init_error, get_firebase_app

        app = get_firebase_app()
        if app is None and firebase_init_error() is None:
            # Firebase is disabled: no bearer token can be valid here.
            raise AppError("unauthenticated", _INVALID_CREDENTIAL_MESSAGE)
        if app is None:
            # Configured but failed to start. Never verify against an implicit
            # default app: it does not exist, and the resulting ValueError used
            # to reject every signed-in user as if their credential were forged.
            raise AppError(
                "unavailable",
                "Sign-in is temporarily unavailable. Please try again shortly.",
                internal_message="Firebase Admin app is not initialized",
            )

        try:
            decoded = auth.verify_id_token(token, app=app, check_revoked=False)
        except Exception as exc:
            # Never downgrade a failed verify to a guest: that is how a forged or
            # stale credential ends up writing to somebody's storage key.
            logger.warning("auth_firebase_verify_failed error=%s", type(exc).__name__)
            raise AppError("unauthenticated", _INVALID_CREDENTIAL_MESSAGE) from exc

        if not check_revoked_tokens():
            return decoded

        try:
            auth.verify_id_token(token, app=app, check_revoked=True)
        except Exception as exc:
            if not _is_transient_lookup_failure(exc):
                # A definite answer: revoked, disabled, expired, or the user no
                # longer exists (deleted in Firebase while this token was still
                # unexpired). Also any unrecognised failure: accepting it is
                # how a deleted account used to keep working for up to an hour.
                logger.warning("auth_token_rejected_by_lookup reason=%s", type(exc).__name__)
                raise AppError("unauthenticated", _INVALID_CREDENTIAL_MESSAGE) from exc
            # Signature and expiry already passed locally and the identity
            # service could not be reached. Refusing would sign every user out
            # during its outage (tokens expire within an hour regardless).
            logger.error(
                "auth_revocation_check_unavailable error=%s — accepting a locally verified token",
                type(exc).__name__,
            )
        return decoded

    def _guest(self) -> UserSession:
        if not self.allow_anonymous:
            raise AppError("unauthenticated", "Sign in to continue.")
        return guest_session()
