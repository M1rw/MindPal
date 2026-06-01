# backend/services/auth_service.py

from __future__ import annotations

from dataclasses import asdict, dataclass
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

    Do not put bearer tokens, refresh tokens, Firebase raw payloads, cookies, or
    provider credentials in this object.
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
    """
    Auth provider protocol.

    A Firebase provider later should implement this interface using Admin SDK
    token verification. This service intentionally does not import Firebase.
    """

    name: str

    @property
    def is_configured(self) -> bool:
        ...

    async def verify_bearer_token(self, token: str) -> AuthIdentity:
        ...


class AuthService:
    """
    Authentication/session boundary.

    Behavior:
    - Bearer tokens are only trusted when a configured provider verifies them.
    - If auth is required, missing/invalid/unconfigured auth fails closed.
    - If auth is not required, fallback anonymous sessions are allowed.
    - raw bearer tokens are never stored in metadata or errors.
    - user_id_hash is the stable identifier for logs/storage.
    """

    def __init__(
        self,
        *,
        provider: AuthProvider | None = None,
        settings: Settings | None = None,
        allow_anonymous: bool = True,
    ) -> None:
        self.settings = settings or get_settings()
        self.provider = provider if provider is not None and provider.is_configured else None
        self.allow_anonymous = allow_anonymous
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
            if self.provider is None:
                if require_auth:
                    self.last_meta = AuthResolutionMeta(
                        mode="auth_required_provider_missing",
                        authenticated=False,
                        provider="none",
                        fallback_used=False,
                        error_code="auth_provider_missing",
                    )
                    raise AuthError(
                        "Authentication provider is not configured",
                        code="auth_provider_missing",
                    )

                return self._anonymous_session(
                    raw_user_id=raw_user_id or "anonymous",
                    channel=resolved_channel,
                    locale=resolved_locale,
                    meta=AuthResolutionMeta(
                        mode="anonymous_fallback_provider_missing",
                        authenticated=False,
                        provider="none",
                        fallback_used=True,
                        error_code="auth_provider_missing",
                    ),
                )

            try:
                identity = await self.provider.verify_bearer_token(token)
                session = self._session_from_identity(
                    identity,
                    channel=resolved_channel,
                    locale=resolved_locale,
                )

                self.last_meta = AuthResolutionMeta(
                    mode="authenticated",
                    authenticated=True,
                    provider=_clean_provider_name(identity.provider),
                    fallback_used=False,
                )

                return session

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
                if require_auth:
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

                return self._anonymous_session(
                    raw_user_id=raw_user_id or "anonymous",
                    channel=resolved_channel,
                    locale=resolved_locale,
                    meta=AuthResolutionMeta(
                        mode="anonymous_fallback_auth_failed",
                        authenticated=False,
                        provider=self.provider.name,
                        fallback_used=True,
                        error_code=exc.__class__.__name__,
                    ),
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

    def health(self) -> dict[str, Any]:
        return {
            "provider": self.provider.name if self.provider else "none",
            "provider_configured": self.provider is not None,
            "allow_anonymous": self.allow_anonymous,
            "firebase_required": False,
            "trusts_unverified_bearer_tokens": False,
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

        clean_raw_id = sanitize_text(raw_user_id or "anonymous", MAX_RAW_USER_ID_CHARS) or "anonymous"

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
            },
        )


def parse_bearer_token(authorization_header: str | None) -> str | None:
    """
    Extract Bearer token from Authorization header.

    Returns token string only for syntactically valid Bearer headers.
    The caller must never log this return value.
    """
    if authorization_header is None:
        return None

    header = sanitize_text(str(authorization_header), MAX_AUTH_HEADER_CHARS)

    if not header:
        return None

    parts = header.split(None, 1)

    if len(parts) != 2:
        return None

    scheme, token = parts[0].lower(), parts[1].strip()

    if scheme != "bearer" or not token:
        return None

    return token


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

        if any(secret in normalized_key for secret in ("token", "secret", "password", "credential", "cookie")):
            continue

        if raw_value is None or isinstance(raw_value, (bool, int, float)):
            cleaned[key] = raw_value
        else:
            cleaned[key] = sanitize_text(str(raw_value), MAX_METADATA_VALUE_CHARS)

    return cleaned