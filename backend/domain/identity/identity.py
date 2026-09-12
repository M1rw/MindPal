# backend/domain/identity/identity.py — User Identity and Profile Domain

from __future__ import annotations

from typing import Dict, Any, Optional
from backend.infra.store.store import get_store
from backend.infra.auth.verifier import AuthVerifier, UserSession


class IdentityService:
    """Manages User Profiles, Export, and Account Deletion."""

    def __init__(self) -> None:
        self.store = get_store()

    def get_profile(self, user_id_hash: str) -> Dict[str, Any]:
        profile = self.store.get_document("user_profiles", user_id_hash)
        if not profile:
            profile = {
                "user_id_hash": user_id_hash,
                "display_name": "MindPal User",
                "created_at": "2026-09-10T00:00:00Z",
                "settings": {"language": "en", "theme": "system"},
            }
            self.store.set_document("user_profiles", user_id_hash, profile)
        return profile

    def export_data(self, user_id_hash: str) -> Dict[str, Any]:
        return {
            "profile": self.get_profile(user_id_hash),
            "exported_at": "2026-09-10T00:00:00Z",
        }

    def delete_account(self, user_id_hash: str) -> bool:
        self.store.delete_document("user_profiles", user_id_hash)
        self.store.delete_document("memory_graphs", user_id_hash)
        return True


def verify_auth_header(auth_header: Optional[str]) -> UserSession:
    return AuthVerifier().verify_authorization_header(auth_header)
