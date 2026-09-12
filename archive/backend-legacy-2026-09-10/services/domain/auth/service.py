# Auth domain service

from __future__ import annotations

from dataclasses import asdict
from typing import Any, Optional

from backend.core.config import Settings, get_settings
from backend.core.errors import AuthError
from backend.core.security import hash_user_id, normalize_locale, sanitize_text
from backend.core.settings_helpers import setting_bool
from backend.models.user import UserChannel, UserSession

from .models import (
    AuthIdentity,
    AuthResolutionMeta,
    MAX_RAW_USER_ID_CHARS,
    MAX_PROVIDER_NAME_CHARS,
    MAX_METADATA_VALUE_CHARS,
)
from .protocols import AuthProvider


class AuthService:
    """
    Clean, focused authentication service.
    
    Responsibilities:
    - Bearer token verification via provider
    - Session creation from identity
    - Anonymous session handling
    - Health reporting
    
    Production rules:
    - Bearer tokens trusted only after verification
    - Invalid tokens fail closed (never fallback to anonymous)
    - Anonymous sessions allowed only when no Authorization header present
    - Required routes must use require_auth=True
    """

    def __init__(
        self,
        *,
        provider: AuthProvider,
        settings: Settings | None = None,
        allow_anonymous: bool | None = None,
    ) -> None:
        self.provider = provider
        self.settings = settings or get_settings()
        self.allow_anonymous = (
            bool(getattr(self.settings, "ALLOW_ANONYMOUS_SESSIONS", False))
            if allow_anonymous is None
            else bool(allow_anonymous)
        )
        self.last_meta: Optional[AuthResolutionMeta] = None

    async def resolve_session(
        self,
        *,
        authorization_header: str | None = None,
        raw_user_id: str | None = None,
        channel: str | UserChannel = UserChannel.WEB,
        locale: str | None = "auto",
        require_auth: bool = False,
    ) -> UserSession:
        """
        Resolve a user session from auth headers or create anonymous.
        
        Args:
            authorization_header: "Authorization: Bearer <token>"
            raw_user_id: User ID for anonymous sessions
            channel: Client channel (web, mobile, api)
            locale: User locale
            require_auth: If True, fail if not authenticated
            
        Returns:
            UserSession (authenticated or anonymous)
            
        Raises:
            AuthError: If authentication required but missing/invalid
        """
        token = parse_bearer_token(authorization_header)
        resolved_channel = _normalize_channel(channel)
        resolved_locale = normalize_locale(locale)

        # Try authenticated path if token present
        if token:
            return await self._resolve_authenticated_token(
                token=token,
                channel=resolved_channel,
                locale=resolved_locale,
            )

        # Auth required but missing
        if require_auth:
            self.last_meta = AuthResolutionMeta(
                mode="auth_required_missing_bearer",
                authenticated=False,
                provider=self.provider.name,
                fallback_used=False,
                error_code="auth_missing_bearer",
            )
            raise AuthError("Authentication is required", code="auth_missing_bearer")

        # Allow anonymous
        return self._anonymous_session(
            raw_user_id=raw_user_id or "anonymous",
            channel=resolved_channel,
            locale=resolved_locale,
        )

    async def verify_app_check_token(self, token: str | None) -> dict[str, Any]:
        """Verify Firebase App Check token."""
        clean_token = (token or "").strip()
        if not clean_token:
            raise AuthError("Firebase App Check token is required", code="app_check_missing")
        
        if not self.provider:
            raise AuthError(
                "Firebase App Check provider not configured",
                code="app_check_provider_missing"
            )

        verifier = getattr(self.provider, "verify_app_check_token", None)
        if not callable(verifier):
            raise AuthError(
                "Authentication provider cannot verify App Check",
                code="app_check_unsupported"
            )

        decoded = await verifier(clean_token)
        app_id = sanitize_text(str(decoded.get("app_id") or decoded.get("sub") or ""), 300)
        
        if not app_id:
            raise AuthError(
                "Firebase App Check token missing app identity",
                code="app_check_identity_missing"
            )
        
        return {"app_id": app_id}

    def health(self) -> dict[str, Any]:
        """Get service health status."""
        return {
            "provider": self.provider.name,
            "provider_configured": self.provider.is_configured,
            "allow_anonymous": self.allow_anonymous,
            "trusts_unverified_bearer_tokens": False,
            "invalid_bearer_falls_back_to_anonymous": False,
            "last_meta": None if self.last_meta is None else asdict(self.last_meta),
        }

    async def _resolve_authenticated_token(
        self,
        *,
        token: str,
        channel: UserChannel,
        locale: str,
    ) -> UserSession:
        """Verify token and create authenticated session."""
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
            raise AuthError("Authentication failed", code="auth_failed") from exc

        session = self._session_from_identity(identity, channel=channel, locale=locale)
        
        self.last_meta = AuthResolutionMeta(
            mode="authenticated",
            authenticated=True,
            provider=_clean_provider_name(identity.provider),
            fallback_used=False,
        )

        return session

    def _session_from_identity(
        self,
        identity: AuthIdentity,
        *,
        channel: UserChannel,
        locale: str,
    ) -> UserSession:
        """Convert AuthIdentity to UserSession."""
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
    ) -> UserSession:
        """Create anonymous session."""
        if not self.allow_anonymous:
            self.last_meta = AuthResolutionMeta(
                mode="anonymous_disabled",
                authenticated=False,
                provider=self.provider.name,
                fallback_used=False,
                error_code="anonymous_disabled",
            )
            raise AuthError("Anonymous sessions are disabled", code="anonymous_disabled")

        clean_raw_id = sanitize_text(raw_user_id or "anonymous", MAX_RAW_USER_ID_CHARS) or "anonymous"

        self.last_meta = AuthResolutionMeta(
            mode="anonymous",
            authenticated=False,
            provider=self.provider.name,
            fallback_used=False,
        )

        return UserSession(
            raw_user_id=clean_raw_id,
            user_id_hash=hash_user_id(f"anonymous:{clean_raw_id}"),
            channel=channel,
            locale=locale,
            authenticated=False,
            metadata={
                "provider": "anonymous",
                "trusted": False,
            },
        )


# Utility functions

def parse_bearer_token(authorization_header: str | None) -> str | None:
    """
    Extract token from Authorization: Bearer <token>.
    
    Returns only syntactically valid Bearer token strings.
    Never log the returned value.
    """
    if authorization_header is None:
        return None

    header = str(authorization_header).replace("\r", " ").replace("\n", " ").strip()

    if not header or len(header) > 8000:
        return None

    parts = header.split(None, 1)

    if len(parts) != 2:
        return None

    scheme, token = parts[0].lower(), parts[1].strip()

    if scheme != "bearer":
        return None

    clean = token.replace("\r", "").replace("\n", "").strip()
    return clean if clean and len(clean) <= 8000 else None


def _normalize_channel(channel: str | UserChannel) -> UserChannel:
    """Normalize channel to enum."""
    if isinstance(channel, UserChannel):
        return channel

    value = sanitize_text(str(channel or ""), 80)

    try:
        return UserChannel(value)
    except ValueError:
        return UserChannel.UNKNOWN


def _clean_provider_name(value: str) -> str:
    """Clean provider name."""
    cleaned = sanitize_text(str(value or ""), MAX_PROVIDER_NAME_CHARS)
    return cleaned or "unknown"


def _sanitize_metadata(metadata: dict[str, Any]) -> dict[str, str | int | float | bool | None]:
    """Sanitize metadata dictionary."""
    cleaned: dict[str, str | int | float | bool | None] = {}

    for raw_key, raw_value in list(metadata.items())[:40]:
        key = sanitize_text(str(raw_key or ""), 80)

        if not key:
            continue

        normalized_key = key.lower().replace("-", "_")

        # Skip secrets
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

