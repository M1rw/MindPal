from __future__ import annotations

from backend.models.user import UserSession
from backend.services.supabase_admin_repository import SupabaseAdminRepository


class AdminAuthority:
    """Resolve trusted administrator state for an authenticated session."""

    def __init__(self, *, repository: SupabaseAdminRepository | None = None) -> None:
        self.repository = repository

    async def is_admin(self, session: UserSession) -> bool:
        if not session.authenticated:
            return False
        if self.repository is None:
            return session.metadata.get("admin") is True
        return await self.repository.is_admin(
            user_id_hash=session.user_id_hash,
            email_hash=str(session.metadata.get("email_hash") or ""),
        )
