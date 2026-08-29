# backend/features/users/auth_service.py

"""
Authentication service and Firebase Admin verification adapter.
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any, Protocol

from backend.core.config import Settings, get_settings
from backend.core.errors import AuthError
from backend.core.security import hash_user_id, normalize_locale, sanitize_text
from backend.core.settings_helpers import setting_bool, setting_secret_str, setting_str
from .schemas import AuthIdentity, AuthResolutionMeta, UserChannel, UserSession

logger = logging.getLogger(__name__)

MAX_AUTH_HEADER_CHARS = 8_000
MAX_RAW_USER_ID_CHARS = 160


class AuthProvider(Protocol):
    name: str

    @property
    def is_configured(self) -> bool:
        ...

    async def verify_bearer_token(self, token: str) -> AuthIdentity:
        ...

    async def verify_app_check_token(self, token: str) -> dict[str, Any]:
        ...


class FirebaseAuthProvider:
    """Firebase Auth verification adapter."""

    name = "firebase"

    def __init__(self, *, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self.project_id = setting_str(self.settings, "FIREBASE_PROJECT_ID") or setting_str(self.settings, "GOOGLE_CLOUD_PROJECT")
        self.app_name = setting_str(self.settings, "FIREBASE_APP_NAME", "mindpal") or "mindpal"
        self.check_revoked = setting_bool(self.settings, "FIREBASE_CHECK_REVOKED_TOKENS", default=False)
        self._app: Any | None = None
        self._init_error: str | None = None

        try:
            self._app = self._build_app()
        except Exception as exc:
            self._init_error = f"{exc.__class__.__name__}: {sanitize_text(str(exc), 500)}"
            self._app = None

    @property
    def is_configured(self) -> bool:
        return self._app is not None or (self.settings.is_test and self.settings.ENABLE_FIREBASE)

    @property
    def init_error(self) -> str | None:
        return self._init_error

    async def verify_bearer_token(self, token: str) -> AuthIdentity:
        clean = str(token or "").strip()
        if not clean or len(clean) > MAX_AUTH_HEADER_CHARS:
            raise AuthError("Missing or invalid bearer token", code="auth_missing_bearer")

        if self._app is None:
            if self.settings.is_test:
                return AuthIdentity(raw_user_id="test_user_id", provider=self.name, email_verified=True)
            raise AuthError("Firebase auth provider is not configured", code="auth_provider_missing", details={"init_error": self._init_error})

        def _verify() -> dict[str, Any]:
            from firebase_admin import auth
            return auth.verify_id_token(clean, app=self._app, check_revoked=self.check_revoked)

        try:
            decoded = await asyncio.to_thread(_verify)
        except Exception as exc:
            raise AuthError("Firebase token verification failed", code="auth_token_rejected") from exc

        uid = sanitize_text(str(decoded.get("uid") or decoded.get("sub") or ""), MAX_RAW_USER_ID_CHARS)
        if not uid:
            raise AuthError("Firebase token is missing uid", code="auth_identity_missing_user_id")

        return AuthIdentity(
            raw_user_id=uid,
            provider=self.name,
            email_verified=bool(decoded.get("email_verified", False)),
            metadata={"project_id": self.project_id, "admin": decoded.get("mindpal_admin") is True},
        )

    async def verify_app_check_token(self, token: str) -> dict[str, Any]:
        clean = str(token or "").strip()
        if not clean:
            raise AuthError("Missing App Check token", code="app_check_missing")
        if self._app is None:
            if self.settings.is_test:
                return {"app_id": "test_app"}
            raise AuthError("Firebase App Check is not configured", code="app_check_provider_missing")

        def _verify() -> dict[str, Any]:
            from firebase_admin import app_check
            return app_check.verify_token(clean, app=self._app)

        try:
            return await asyncio.to_thread(_verify)
        except Exception as exc:
            raise AuthError("App Check token verification failed", code="app_check_rejected") from exc

    def _build_app(self) -> Any:
        import firebase_admin
        if not self.project_id:
            raise RuntimeError("Missing FIREBASE_PROJECT_ID")
        if self.app_name in firebase_admin._apps:
            return firebase_admin.get_app(self.app_name)

        cred = _build_credentials(self.settings, self.project_id)
        if cred is None and self.settings.is_test:
            return None
        return firebase_admin.initialize_app(cred, {"projectId": self.project_id}, name=self.app_name)


class AuthService:
    """User authentication and session resolution gateway."""

    def __init__(
        self,
        *,
        provider: AuthProvider | None = None,
        settings: Settings | None = None,
        allow_anonymous: bool | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.allow_anonymous = (
            bool(getattr(self.settings, "ALLOW_ANONYMOUS_SESSIONS", False))
            if allow_anonymous is None
            else bool(allow_anonymous)
        )
        if provider is not None and provider.is_configured:
            self.provider: AuthProvider | None = provider
            self.provider_init_error: str | None = None
        else:
            firebase = FirebaseAuthProvider(settings=self.settings)
            self.provider = firebase if firebase.is_configured else None
            self.provider_init_error = firebase.init_error

    async def resolve_session(
        self,
        *,
        authorization_header: str | None = None,
        channel: str = "web",
        locale: str = "auto",
        require_auth: bool = False,
    ) -> tuple[UserSession, AuthResolutionMeta]:
        auth_header = str(authorization_header or "").strip()
        bearer_token = auth_header[7:].strip() if auth_header.lower().startswith("bearer ") else None

        if bearer_token:
            if self.provider is None:
                raise AuthError("Authentication provider unavailable", code="auth_provider_unavailable")
            identity = await self.provider.verify_bearer_token(bearer_token)
            user_hash = hash_user_id(f"uid:{identity.raw_user_id}")
            is_admin = bool(identity.metadata and identity.metadata.get("admin") is True)
            session = UserSession(
                user_id_hash=user_hash,
                channel=_clean_channel(channel),
                locale=normalize_locale(locale),
                authenticated=True,
                is_admin=is_admin,
                auth_provider=identity.provider,
            )
            meta = AuthResolutionMeta(mode="bearer", authenticated=True, provider=identity.provider, fallback_used=False)
            return session, meta

        if require_auth or not self.allow_anonymous:
            raise AuthError("Authentication required", code="auth_required")

        anon_hash = hash_user_id("anonymous_session")
        session = UserSession(
            user_id_hash=anon_hash,
            channel=_clean_channel(channel),
            locale=normalize_locale(locale),
            authenticated=False,
            is_admin=False,
            auth_provider="anonymous",
        )
        meta = AuthResolutionMeta(mode="anonymous", authenticated=False, provider="anonymous", fallback_used=False)
        return session, meta


def _clean_channel(channel: str | UserChannel) -> UserChannel:
    if isinstance(channel, UserChannel):
        return channel
    try:
        return UserChannel(str(channel or "").strip().lower())
    except ValueError:
        return UserChannel.UNKNOWN


def _build_credentials(settings: Settings, project_id: str) -> Any:
    from firebase_admin import credentials
    raw_json = setting_secret_str(settings, "FIREBASE_CREDENTIALS_JSON")
    if raw_json:
        return credentials.Certificate(json.loads(raw_json))

    path = setting_str(settings, "FIREBASE_CREDENTIALS_PATH") or setting_str(settings, "GOOGLE_APPLICATION_CREDENTIALS")
    if path and Path(path).exists():
        return credentials.Certificate(path)

    if setting_bool(settings, "FIREBASE_USE_APPLICATION_DEFAULT", default=False):
        try:
            return credentials.ApplicationDefault()
        except Exception:
            if settings.is_test:
                return None
            raise
    return None
