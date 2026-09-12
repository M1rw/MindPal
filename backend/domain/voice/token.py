# backend/domain/voice/token.py — Voice Session Token Domain

from __future__ import annotations

import time
import secrets
from typing import Dict, Any


class VoiceTokenService:
    """Generates short-lived WebRTC/Voice tokens for authorized sessions."""

    def create_voice_token(self, user_id_hash: str) -> Dict[str, Any]:
        token = f"vt_{secrets.token_urlsafe(16)}"
        expires_at = int(time.time()) + 3600
        return {
            "token": token,
            "expires_at": expires_at,
            "user_id_hash": user_id_hash,
            "status": "active",
        }
