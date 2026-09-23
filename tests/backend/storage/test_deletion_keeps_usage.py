# tests/backend/storage/test_deletion_keeps_usage.py - "delete my data" is not a quota refill
"""Audit MP-05: DELETE /api/user/data removed user_quotas and
voice_minute_reservations, so a signed-in account could reset its chat
credits and daily voice minutes as often as it liked."""

from __future__ import annotations

from backend.domain.identity.identity import IdentityService
from backend.domain.quota.quota import QuotaService
from backend.infra.store.providers.memory import InMemoryStore

USER = "usr_quota_keeper"


def test_chat_credits_survive_account_data_deletion() -> None:
    store = InMemoryStore()
    quota = QuotaService(store)
    for _ in range(7):
        assert quota.reserve(USER, 1).allowed
    before = quota.snapshot(USER)
    assert before.credits_5h == 7

    identity = IdentityService()
    identity.store = store
    identity.delete_account(USER)

    after = quota.snapshot(USER)
    assert after.credits_5h == 7 and after.reset_5h_seconds <= before.reset_5h_seconds


def test_voice_minutes_survive_account_data_deletion() -> None:
    store = InMemoryStore()
    store.set_document("voice_minute_reservations", USER, {"day": "2026-09-23", "used_s": 1_200})
    identity = IdentityService()
    identity.store = store
    identity.delete_account(USER)
    assert store.get_document("voice_minute_reservations", USER) == {"day": "2026-09-23", "used_s": 1_200}


def test_exported_safety_retention_matches_what_telemetry_writes() -> None:
    """Audit MP-29: export said 90 days; telemetry expired safety events after 30."""
    from backend.domain.voice.privacy import VoicePrivacyService
    from backend.domain.voice.telemetry import VOICE_TELEMETRY_RETENTION_S

    label = VoicePrivacyService(InMemoryStore()).export_account(USER)["policy"]["safety_events"]
    assert label == f"sanitized_{VOICE_TELEMETRY_RETENTION_S // 86_400}_day_retention"
