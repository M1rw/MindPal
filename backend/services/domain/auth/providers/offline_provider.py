# Offline authentication provider (fallback)

from __future__ import annotations

from typing import Any

from backend.core.errors import AuthError
from backend.core.security import hash_user_id, sanitize_text

from ..models import AuthIdentity, MAX_RAW_USER_ID_CHARS


class OfflineAuthProvider:
    """
    Offline authentication provider (development/testing fallback).
    
    Usage in development:
    - Accepts any Bearer token
    - Uses token value as user ID
    - No verification
    
    Never use in production!
    """

    name = "offline"

    def __init__(self) -> None:
        pass

    @property
    def is_configured(self) -> bool:
        """Always configured."""
        return True

    async def verify_bearer_token(self, token: str) -> AuthIdentity:
        """Accept any token and use as user ID."""
        clean_token = (token or "").strip()

        if not clean_token:
            raise AuthError("Missing bearer token", code="auth_missing_bearer")

        # Use token hash as user ID
        user_id = sanitize_text(clean_token, MAX_RAW_USER_ID_CHARS) or "offline_user"

        return AuthIdentity(
            raw_user_id=user_id,
            provider=self.name,
            email_verified=False,
            metadata={
                "mode": "offline_development",
                "warning": "This provider should never be used in production",
            },
        )

    async def verify_app_check_token(self, token: str) -> dict[str, Any]:
        """Offline app check (always succeeds)."""
        clean_token = (token or "").strip()
        if not clean_token:
            raise AuthError("Missing App Check token", code="app_check_missing")
        
        return {
            "app_id": "offline_app",
            "mode": "offline_development",
        }

