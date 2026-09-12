# Auth domain protocols

from typing import Any, Protocol

from .models import AuthIdentity


class AuthProvider(Protocol):
    """
    Authentication provider protocol.
    
    Implementations: Firebase, Offline, Custom
    """
    
    name: str

    @property
    def is_configured(self) -> bool:
        """Check if provider is properly configured."""
        ...

    async def verify_bearer_token(self, token: str) -> AuthIdentity:
        """Verify and decode a bearer token."""
        ...

    async def verify_app_check_token(self, token: str) -> dict[str, Any]:
        """Verify app check token (Firebase)."""
        ...

