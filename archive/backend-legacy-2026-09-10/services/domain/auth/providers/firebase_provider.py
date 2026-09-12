# Firebase authentication provider

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from backend.core.config import Settings, get_settings
from backend.core.errors import AuthError
from backend.core.security import hash_user_id, sanitize_text
from backend.core.settings_helpers import setting_bool, setting_secret_str, setting_str

from ..models import AuthIdentity, MAX_METADATA_VALUE_CHARS, MAX_RAW_USER_ID_CHARS

logger = logging.getLogger(__name__)


class FirebaseAuthProvider:
    """
    Firebase Auth ID-token verifier.

    Production behavior:
    - verifies Bearer tokens through Firebase Admin SDK
    - never trusts client-supplied user IDs
    - never falls back to anonymous when an Authorization header is invalid
    - supports Vercel via FIREBASE_CREDENTIALS_JSON
    """

    name = "firebase"

    def __init__(self, *, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self.project_id = _firebase_project_id(self.settings)
        self.app_name = setting_str(self.settings, "FIREBASE_APP_NAME", "mindpal") or "mindpal"
        self.check_revoked = setting_bool(
            self.settings,
            "FIREBASE_CHECK_REVOKED_TOKENS",
            default=False,
        )

        self._app: Any | None = None
        self._init_error: str | None = None

        try:
            self._app = self._build_app()
        except Exception as exc:
            self._init_error = f"{exc.__class__.__name__}: {sanitize_text(str(exc), 500)}"
            self._app = None

    @property
    def is_configured(self) -> bool:
        """Check if Firebase is configured."""
        if self._init_error is not None:
            return False
        if self._app is not None:
            return True
        return bool(
            self.settings.is_test
            and self.settings.ENABLE_FIREBASE
            and getattr(self.settings, "FIREBASE_USE_APPLICATION_DEFAULT", False)
        )

    @property
    def init_error(self) -> str | None:
        """Get initialization error if any."""
        return self._init_error

    async def verify_bearer_token(self, token: str) -> AuthIdentity:
        """Verify Firebase ID token."""
        clean_token = _clean_token(token)

        if not clean_token:
            raise AuthError("Missing bearer token", code="auth_missing_bearer")

        if self._app is None:
            raise AuthError(
                "Firebase authentication provider is not configured",
                code="auth_provider_missing",
                details={"init_error": self._init_error},
            )

        def _verify() -> dict[str, Any]:
            from firebase_admin import auth
            return auth.verify_id_token(
                clean_token,
                app=self._app,
                check_revoked=self.check_revoked,
            )

        try:
            decoded = await asyncio.to_thread(_verify)
        except Exception as exc:
            raise AuthError(
                "Firebase token verification failed",
                code="auth_token_rejected",
            ) from exc

        uid = sanitize_text(
            str(decoded.get("uid") or decoded.get("sub") or ""),
            MAX_RAW_USER_ID_CHARS,
        )

        if not uid:
            raise AuthError(
                "Firebase token is missing uid",
                code="auth_identity_missing_user_id",
            )

        firebase_claims = decoded.get("firebase")
        firebase_provider = None

        if isinstance(firebase_claims, dict):
            firebase_provider = firebase_claims.get("sign_in_provider")

        email_verified = bool(decoded.get("email_verified", False))
        metadata: dict[str, str | int | float | bool | None] = {
            "project_id": self.project_id,
            "email_verified": email_verified,
            "email_hash": _firebase_email_hash(decoded.get("email"), email_verified),
            "admin": decoded.get("mindpal_admin") is True,
        }

        if firebase_provider:
            metadata["firebase_sign_in_provider"] = sanitize_text(
                str(firebase_provider),
                MAX_METADATA_VALUE_CHARS,
            )

        auth_time = decoded.get("auth_time")
        if isinstance(auth_time, (int, float)):
            metadata["auth_time"] = int(auth_time)

        return AuthIdentity(
            raw_user_id=uid,
            provider=self.name,
            email_verified=email_verified,
            metadata=metadata,
        )

    async def verify_app_check_token(self, token: str) -> dict[str, Any]:
        """Verify Firebase App Check token."""
        clean_token = _clean_token(token)
        if not clean_token:
            raise AuthError("Missing Firebase App Check token", code="app_check_missing")
        if self._app is None:
            raise AuthError(
                "Firebase App Check is not configured",
                code="app_check_provider_missing"
            )

        def _verify() -> dict[str, Any]:
            from firebase_admin import app_check
            return app_check.verify_token(clean_token, app=self._app)

        try:
            decoded = await asyncio.to_thread(_verify)
        except Exception as exc:
            raise AuthError(
                "Firebase App Check token verification failed",
                code="app_check_rejected"
            ) from exc
        return decoded

    def _build_app(self) -> Any:
        """Build Firebase app."""
        try:
            import firebase_admin
        except Exception as exc:
            if self.settings.is_test:
                return None
            raise RuntimeError("firebase-admin is not installed") from exc

        if not self.project_id:
            raise RuntimeError("Missing FIREBASE_PROJECT_ID or GOOGLE_CLOUD_PROJECT")

        if self.app_name in firebase_admin._apps:
            return firebase_admin.get_app(self.app_name)

        credential = _firebase_credentials(self.settings, expected_project_id=self.project_id)
        if credential is None and self.settings.is_test:
            return None

        return firebase_admin.initialize_app(
            credential,
            {"projectId": self.project_id},
            name=self.app_name,
        )


# Utility functions

def _firebase_email_hash(value: object, email_verified: bool) -> str:
    """Generate deterministic email hash."""
    if not email_verified or not isinstance(value, str):
        return ""
    normalized = value.strip().casefold()
    if not normalized or len(normalized) > 320 or "@" not in normalized:
        return ""
    return hash_user_id(f"firebase-email:{normalized}")


def _clean_token(token: str) -> str:
    """Clean and validate token string."""
    clean = str(token or "").replace("\r", "").replace("\n", "").strip()
    if not clean or len(clean) > 8000:
        return ""
    return clean


def _firebase_project_id(settings: Settings) -> str:
    """Get Firebase project ID."""
    explicit = (
        setting_str(settings, "FIREBASE_PROJECT_ID")
        or setting_str(settings, "GOOGLE_CLOUD_PROJECT")
    )
    if explicit:
        return explicit

    raw_json = setting_secret_str(settings, "FIREBASE_CREDENTIALS_JSON")
    if raw_json:
        try:
            import json
            data = json.loads(raw_json)
            project_id = sanitize_text(str(data.get("project_id") or ""), 160)
            if project_id:
                return project_id
        except Exception:
            pass

    credentials_path = (
        setting_str(settings, "FIREBASE_CREDENTIALS_PATH")
        or setting_str(settings, "GOOGLE_APPLICATION_CREDENTIALS")
    )
    if credentials_path:
        try:
            import json
            from pathlib import Path
            path = Path(credentials_path)
            if not path.is_absolute():
                path = Path.cwd() / path
            if path.exists():
                data = json.loads(path.read_text(encoding="utf-8"))
                project_id = sanitize_text(str(data.get("project_id") or ""), 160)
                if project_id:
                    return project_id
        except Exception:
            pass

    return ""


def _firebase_credentials(settings: Settings, *, expected_project_id: str) -> Any:
    """Get Firebase credentials."""
    try:
        from firebase_admin import credentials
    except Exception as exc:
        if settings.is_test:
            return None
        raise RuntimeError("firebase-admin credentials module is unavailable") from exc

    # Try environment-based credentials
    json_credentials = setting_secret_str(settings, "FIREBASE_CREDENTIALS_JSON")
    if json_credentials:
        import json
        try:
            data = json.loads(json_credentials)
            return credentials.Certificate(data)
        except Exception as exc:
            raise ValueError("Invalid FIREBASE_CREDENTIALS_JSON") from exc

    # Try file-based credentials
    credentials_path = setting_str(settings, "FIREBASE_CREDENTIALS_PATH")
    if credentials_path:
        try:
            return credentials.Certificate(credentials_path)
        except Exception as exc:
            raise ValueError(f"Invalid FIREBASE_CREDENTIALS_PATH: {credentials_path}") from exc

    # Try application default credentials
    if setting_bool(settings, "FIREBASE_USE_APPLICATION_DEFAULT", default=False):
        return credentials.ApplicationDefault()

    return None

