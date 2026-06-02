# backend/services/auth_service.py

from __future__ import annotations

import asyncio
import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Protocol

from backend.core.config import Settings, get_settings
from backend.core.errors import AuthError
from backend.core.security import hash_user_id, normalize_locale, sanitize_text
from backend.models.user import UserChannel, UserSession


MAX_AUTH_HEADER_CHARS = 8_000
MAX_RAW_USER_ID_CHARS = 160
MAX_PROVIDER_NAME_CHARS = 80
MAX_METADATA_VALUE_CHARS = 300


@dataclass(frozen=True, slots=True)
class AuthIdentity:
    """
    Sanitized authenticated identity returned by an auth provider.

    Never store:
    - bearer tokens
    - refresh tokens
    - Firebase raw payloads
    - cookies
    - provider credentials
    """

    raw_user_id: str
    provider: str
    email_verified: bool = False
    metadata: dict[str, str | int | float | bool | None] | None = None


@dataclass(frozen=True, slots=True)
class AuthResolutionMeta:
    mode: str
    authenticated: bool
    provider: str
    fallback_used: bool
    error_code: str | None = None


class AuthProvider(Protocol):
    name: str

    @property
    def is_configured(self) -> bool:
        ...

    async def verify_bearer_token(self, token: str) -> AuthIdentity:
        ...


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
        self.app_name = _setting_str(self.settings, "FIREBASE_APP_NAME", "mindpal") or "mindpal"
        self.check_revoked = _setting_bool(
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
        return self._app is not None

    @property
    def init_error(self) -> str | None:
        return self._init_error

    async def verify_bearer_token(self, token: str) -> AuthIdentity:
        clean_token = _clean_token(token)

        if not clean_token:
            raise AuthError(
                "Missing bearer token",
                code="auth_missing_bearer",
            )

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

        metadata: dict[str, str | int | float | bool | None] = {
            "project_id": self.project_id,
            "email_verified": bool(decoded.get("email_verified", False)),
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
            email_verified=bool(decoded.get("email_verified", False)),
            metadata=metadata,
        )

    def _build_app(self) -> Any:
        try:
            import firebase_admin
        except Exception as exc:
            raise RuntimeError("firebase-admin is not installed") from exc

        if not self.project_id:
            raise RuntimeError("Missing FIREBASE_PROJECT_ID or GOOGLE_CLOUD_PROJECT")

        if self.app_name in firebase_admin._apps:
            return firebase_admin.get_app(self.app_name)

        credential = _firebase_credentials(self.settings, expected_project_id=self.project_id)

        return firebase_admin.initialize_app(
            credential,
            {"projectId": self.project_id},
            name=self.app_name,
        )


class AuthService:
    """
    Authentication/session boundary.

    Production rules:
    - Bearer tokens are trusted only after Firebase Admin verification.
    - Invalid Bearer tokens fail closed; they never become anonymous sessions.
    - Anonymous sessions are allowed only when no Authorization header is present
      and allow_anonymous=True.
    - Required routes must pass require_auth=True.
    - Raw tokens are never logged or stored.
    """

    def __init__(
        self,
        *,
        provider: AuthProvider | None = None,
        settings: Settings | None = None,
        allow_anonymous: bool | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.allow_anonymous = (
            _allow_anonymous_sessions(self.settings)
            if allow_anonymous is None
            else bool(allow_anonymous)
        )

        if provider is not None and provider.is_configured:
            self.provider: AuthProvider | None = provider
            self.provider_init_error: str | None = None
        else:
            firebase_provider = FirebaseAuthProvider(settings=self.settings)
            self.provider = firebase_provider if firebase_provider.is_configured else None
            self.provider_init_error = firebase_provider.init_error

        self.last_meta: AuthResolutionMeta | None = None

    async def resolve_session(
        self,
        *,
        authorization_header: str | None = None,
        raw_user_id: str | None = None,
        channel: str | UserChannel = UserChannel.WEB,
        locale: str | None = "auto",
        require_auth: bool = False,
    ) -> UserSession:
        token = parse_bearer_token(authorization_header)
        resolved_channel = _normalize_channel(channel)
        resolved_locale = normalize_locale(locale)

        if token:
            return await self._resolve_authenticated_token(
                token=token,
                channel=resolved_channel,
                locale=resolved_locale,
            )

        if require_auth:
            self.last_meta = AuthResolutionMeta(
                mode="auth_required_missing_bearer",
                authenticated=False,
                provider=self.provider.name if self.provider else "none",
                fallback_used=False,
                error_code="auth_missing_bearer",
            )
            raise AuthError(
                "Authentication is required",
                code="auth_missing_bearer",
            )

        return self._anonymous_session(
            raw_user_id=raw_user_id or "anonymous",
            channel=resolved_channel,
            locale=resolved_locale,
            meta=AuthResolutionMeta(
                mode="anonymous",
                authenticated=False,
                provider=self.provider.name if self.provider else "none",
                fallback_used=False,
            ),
        )

    async def _resolve_authenticated_token(
        self,
        *,
        token: str,
        channel: UserChannel,
        locale: str,
    ) -> UserSession:
        if self.provider is None:
            self.last_meta = AuthResolutionMeta(
                mode="auth_provider_missing",
                authenticated=False,
                provider="none",
                fallback_used=False,
                error_code="auth_provider_missing",
            )
            raise AuthError(
                "Authentication provider is not configured",
                code="auth_provider_missing",
                details={"init_error": self.provider_init_error},
            )

        try:
            identity = await self.provider.verify_bearer_token(token)
        except AuthError:
            self.last_meta = AuthResolutionMeta(
                mode="auth_provider_rejected",
                authenticated=False,
                provider=self.provider.name,
                fallback_used=False,
                error_code="auth_rejected",
            )
            raise
        except Exception as exc:
            self.last_meta = AuthResolutionMeta(
                mode="auth_provider_failed",
                authenticated=False,
                provider=self.provider.name,
                fallback_used=False,
                error_code=exc.__class__.__name__,
            )
            raise AuthError(
                "Authentication failed",
                code="auth_failed",
            ) from exc

        session = self._session_from_identity(
            identity,
            channel=channel,
            locale=locale,
        )

        self.last_meta = AuthResolutionMeta(
            mode="authenticated",
            authenticated=True,
            provider=_clean_provider_name(identity.provider),
            fallback_used=False,
        )

        return session

    def health(self) -> dict[str, Any]:
        return {
            "provider": self.provider.name if self.provider else "none",
            "provider_configured": self.provider is not None,
            "allow_anonymous": self.allow_anonymous,
            "firebase_required": _firebase_env_present(self.settings),
            "provider_init_error": self.provider_init_error,
            "trusts_unverified_bearer_tokens": False,
            "invalid_bearer_falls_back_to_anonymous": False,
            "last_meta": None if self.last_meta is None else asdict(self.last_meta),
        }

    def _session_from_identity(
        self,
        identity: AuthIdentity,
        *,
        channel: UserChannel,
        locale: str,
    ) -> UserSession:
        raw_user_id = sanitize_text(identity.raw_user_id, MAX_RAW_USER_ID_CHARS)

        if not raw_user_id:
            raise AuthError(
                "Authenticated identity is missing user id",
                code="auth_identity_missing_user_id",
            )

        provider = _clean_provider_name(identity.provider)
        metadata = _sanitize_metadata(identity.metadata or {})
        metadata["provider"] = provider
        metadata["email_verified"] = bool(identity.email_verified)

        return UserSession(
            raw_user_id=raw_user_id,
            user_id_hash=hash_user_id(f"{provider}:{raw_user_id}"),
            channel=channel,
            locale=locale,
            authenticated=True,
            metadata=metadata,
        )

    def _anonymous_session(
        self,
        *,
        raw_user_id: str,
        channel: UserChannel,
        locale: str,
        meta: AuthResolutionMeta,
    ) -> UserSession:
        if not self.allow_anonymous:
            self.last_meta = AuthResolutionMeta(
                mode="anonymous_disabled",
                authenticated=False,
                provider=meta.provider,
                fallback_used=meta.fallback_used,
                error_code="anonymous_disabled",
            )
            raise AuthError(
                "Anonymous sessions are disabled",
                code="anonymous_disabled",
            )

        clean_raw_id = sanitize_text(
            raw_user_id or "anonymous",
            MAX_RAW_USER_ID_CHARS,
        ) or "anonymous"

        self.last_meta = meta

        return UserSession(
            raw_user_id=clean_raw_id,
            user_id_hash=hash_user_id(f"anonymous:{clean_raw_id}"),
            channel=channel,
            locale=locale,
            authenticated=False,
            metadata={
                "provider": "anonymous",
                "fallback_used": meta.fallback_used,
                "trusted": False,
            },
        )


def parse_bearer_token(authorization_header: str | None) -> str | None:
    """
    Extract token from Authorization: Bearer <token>.

    Returns only syntactically valid Bearer token strings.
    Never log the returned value.
    """
    if authorization_header is None:
        return None

    header = str(authorization_header).replace("\r", " ").replace("\n", " ").strip()

    if not header or len(header) > MAX_AUTH_HEADER_CHARS:
        return None

    parts = header.split(None, 1)

    if len(parts) != 2:
        return None

    scheme, token = parts[0].lower(), parts[1].strip()

    if scheme != "bearer":
        return None

    return _clean_token(token) or None


def _clean_token(token: str) -> str:
    clean = str(token or "").replace("\r", "").replace("\n", "").strip()

    if not clean or len(clean) > MAX_AUTH_HEADER_CHARS:
        return ""

    return clean


def _normalize_channel(channel: str | UserChannel) -> UserChannel:
    if isinstance(channel, UserChannel):
        return channel

    value = sanitize_text(str(channel or ""), 80)

    try:
        return UserChannel(value)
    except ValueError:
        return UserChannel.UNKNOWN


def _clean_provider_name(value: str) -> str:
    cleaned = sanitize_text(str(value or ""), MAX_PROVIDER_NAME_CHARS)
    return cleaned or "unknown"


def _sanitize_metadata(
    metadata: dict[str, Any],
) -> dict[str, str | int | float | bool | None]:
    cleaned: dict[str, str | int | float | bool | None] = {}

    for raw_key, raw_value in list(metadata.items())[:40]:
        key = sanitize_text(str(raw_key or ""), 80)

        if not key:
            continue

        normalized_key = key.lower().replace("-", "_")

        if any(
            secret in normalized_key
            for secret in ("token", "secret", "password", "credential", "cookie", "key")
        ):
            continue

        if raw_value is None or isinstance(raw_value, (bool, int, float)):
            cleaned[key] = raw_value
        else:
            cleaned[key] = sanitize_text(str(raw_value), MAX_METADATA_VALUE_CHARS)

    return cleaned


def _setting_value(settings: Settings, name: str, default: Any = None) -> Any:
    value = getattr(settings, name, None)

    if value is None:
        return os.getenv(name, default)

    if hasattr(value, "get_secret_value"):
        return value.get_secret_value()

    return value


def _setting_str(settings: Settings, name: str, default: str = "") -> str:
    value = _setting_value(settings, name, default)
    return sanitize_text(str(value or ""), 1_000)


def _setting_secret_str(settings, name, default=""):
    value = _setting_value(settings, name, default)

    if value is None:
        return default

    if hasattr(value, "get_secret_value"):
        value = value.get_secret_value()

    return str(value or default).strip()

def _setting_bool(settings: Settings, name: str, *, default: bool) -> bool:
    value = _setting_value(settings, name, None)

    if value is None:
        return default

    if isinstance(value, bool):
        return value

    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _firebase_project_id(settings: Settings) -> str:
    return (
        _setting_str(settings, "FIREBASE_PROJECT_ID")
        or _setting_str(settings, "GOOGLE_CLOUD_PROJECT")
    )


def _firebase_env_present(settings: Settings) -> bool:
    return bool(
        _setting_str(settings, "FIREBASE_CREDENTIALS_JSON")
        or _setting_str(settings, "FIREBASE_CREDENTIALS_PATH")
        or _setting_str(settings, "GOOGLE_APPLICATION_CREDENTIALS")
        or _setting_bool(settings, "FIREBASE_USE_APPLICATION_DEFAULT", default=False)
    )


def _allow_anonymous_sessions(settings: Settings) -> bool:
    return _setting_bool(settings, "ALLOW_ANONYMOUS_SESSIONS", default=True)


def _firebase_credentials(settings: Settings, *, expected_project_id: str) -> Any:
    try:
        from firebase_admin import credentials
    except Exception as exc:
        raise RuntimeError("firebase-admin credentials module is unavailable") from exc

    raw_json = _setting_secret_str(settings, "FIREBASE_CREDENTIALS_JSON")
    credentials_path = (
        _setting_str(settings, "FIREBASE_CREDENTIALS_PATH")
        or _setting_str(settings, "GOOGLE_APPLICATION_CREDENTIALS")
    )
    use_adc = _setting_bool(settings, "FIREBASE_USE_APPLICATION_DEFAULT", default=False)

    if raw_json:
        try:
            data = json.loads(raw_json)
        except json.JSONDecodeError as exc:
            raise RuntimeError("FIREBASE_CREDENTIALS_JSON is not valid JSON") from exc

        actual_project_id = sanitize_text(str(data.get("project_id") or ""), 160)

        if expected_project_id and actual_project_id and actual_project_id != expected_project_id:
            raise RuntimeError(
                "Firebase credentials project_id does not match FIREBASE_PROJECT_ID"
            )

        private_key = str(data.get("private_key", ""))
        if "\\n" in private_key:
            data["private_key"] = private_key.replace("\\n", "\n")

        return credentials.Certificate(data)

    if credentials_path:
        path = Path(credentials_path)
        if not path.is_absolute():
            path = Path.cwd() / path

        if not path.exists():
            raise RuntimeError(f"Firebase credentials file not found: {path}")

        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Firebase credentials file is not valid JSON: {path}") from exc

        actual_project_id = sanitize_text(str(data.get("project_id") or ""), 160)

        if expected_project_id and actual_project_id and actual_project_id != expected_project_id:
            raise RuntimeError(
                "Firebase credentials project_id does not match FIREBASE_PROJECT_ID"
            )

        return credentials.Certificate(data)

    if use_adc:
        return credentials.ApplicationDefault()

    raise RuntimeError(
        "Missing Firebase credentials. Set FIREBASE_CREDENTIALS_JSON, "
        "FIREBASE_CREDENTIALS_PATH, or FIREBASE_USE_APPLICATION_DEFAULT=true."
    )