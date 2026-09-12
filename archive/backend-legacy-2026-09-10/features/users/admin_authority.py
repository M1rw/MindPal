# backend/features/users/admin_authority.py

"""
Admin authority resolution and privilege verification.
"""

from __future__ import annotations

from typing import Protocol


class AdminAuthority(Protocol):
    async def is_admin(self, user_id_hash: str) -> bool:
        ...


class AlwaysAllowAdminAuthority:
    """Mock/testing authority granting admin privileges."""

    async def is_admin(self, user_id_hash: str) -> bool:
        return True


class DefaultAdminAuthority:
    """Standard admin authority backed by user session metadata or database lookup."""

    def __init__(self, admin_hashes: set[str] | None = None) -> None:
        self._admin_hashes = admin_hashes or set()

    async def is_admin(self, user_id_hash: str) -> bool:
        return user_id_hash in self._admin_hashes
