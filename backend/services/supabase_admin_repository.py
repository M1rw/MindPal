from __future__ import annotations

from dataclasses import dataclass

from backend.services.supabase_client import SupabaseClient


@dataclass(frozen=True, slots=True)
class SupabaseAdminRecord:
    is_admin: bool


class SupabaseAdminRepository:
    """Read administrator state from the Supabase control plane.

    Firebase verifies the bearer token. Supabase stores only hashed identity
    keys, so neither raw UID nor email is persisted or sent to PostgREST.
    """

    TABLE = "mindpal_admin_accounts"

    def __init__(self, *, client: SupabaseClient) -> None:
        self.client = client

    async def is_admin(
        self,
        *,
        user_id_hash: str,
        email_hash: str,
    ) -> bool:
        for identity_column, identity_hash in (
            ("firebase_user_hash", user_id_hash),
            ("firebase_email_hash", email_hash),
        ):
            if not identity_hash:
                continue
            response = await self.client.request(
                "GET",
                f"/rest/v1/{self.TABLE}",
                params={
                    "select": "is_admin",
                    identity_column: f"eq.{identity_hash}",
                    "limit": "1",
                },
            )
            rows = self.client.decode_json(response)
            if not isinstance(rows, list) or not rows:
                continue
            record = rows[0]
            if isinstance(record, dict) and record.get("is_admin") is True:
                return True
        return False
