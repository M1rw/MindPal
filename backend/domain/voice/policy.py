from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from backend.configs.runtime import voice_runtime_settings


@dataclass(frozen=True, slots=True)
class VoicePolicy:
    is_authenticated: bool
    guest_id: str
    session_mode: str
    max_session_seconds: int
    daily_cap_seconds: int
    reserve_seconds: int
    min_session_seconds: int
    allow_reconnect: bool
    allow_persistent_memory: bool
    fallback_mode: str
    quota_label: str


def resolve_voice_policy(*, is_authenticated: bool, guest_id: str = "", extra: dict[str, Any] | None = None) -> VoicePolicy:
    """Resolve the right voice entitlement and session rules for a request.

    This is the product-policy boundary that makes guest and signed-in users
    behave differently without scattering rules across UI and backend code.
    """
    configured = voice_runtime_settings().policy
    extra = extra or {}

    if not is_authenticated:
        return VoicePolicy(
            is_authenticated=False,
            guest_id=str(guest_id or "guest-device"),
            session_mode="guest",
            max_session_seconds=int(extra.get("guest_max_session_seconds", configured.guest_max_session_seconds)),
            daily_cap_seconds=int(extra.get("guest_daily_cap_seconds", configured.guest_daily_cap_seconds)),
            reserve_seconds=int(extra.get("guest_reserve_seconds", configured.guest_reserve_seconds)),
            min_session_seconds=int(extra.get("guest_min_session_seconds", configured.guest_min_session_seconds)),
            allow_reconnect=bool(extra.get("guest_allow_reconnect", configured.guest_allow_reconnect)),
            allow_persistent_memory=bool(extra.get("guest_allow_persistent_memory", configured.guest_allow_persistent_memory)),
            fallback_mode=str(extra.get("guest_fallback_mode", configured.guest_fallback_mode)),
            quota_label="guest",
        )

    return VoicePolicy(
        is_authenticated=True,
        guest_id="",
        session_mode="account",
        max_session_seconds=int(extra.get("account_max_session_seconds", configured.account_max_session_seconds)),
        daily_cap_seconds=int(extra.get("account_daily_cap_seconds", configured.account_daily_cap_seconds)),
        reserve_seconds=int(extra.get("account_reserve_seconds", configured.account_reserve_seconds)),
        min_session_seconds=int(extra.get("account_min_session_seconds", configured.account_min_session_seconds)),
        allow_reconnect=bool(extra.get("account_allow_reconnect", configured.account_allow_reconnect)),
        allow_persistent_memory=bool(extra.get("account_allow_persistent_memory", configured.account_allow_persistent_memory)),
        fallback_mode=str(extra.get("account_fallback_mode", configured.account_fallback_mode)),
        quota_label="account",
    )
