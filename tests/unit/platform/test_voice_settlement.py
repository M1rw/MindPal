# tests/unit/platform/test_voice_settlement.py
#
# Voice minutes are settled from the server's own record of the session. The
# client used to name the outcome: sending reason="setup_timeout" on teardown
# refunded the entire reservation regardless of how long the call had actually
# run, which made the daily cap advisory for anyone able to edit a request body.

from __future__ import annotations

import time

import pytest

from backend.core.errors import AppError
from backend.domain.flags.models import FeatureDefinition, FeatureStage
from backend.domain.flags.engine import FeatureLifecycleEngine
from backend.domain.voice.session import (
    DAILY_CAP_SECONDS,
    SETUP_FAILURE_REASONS,
    VoiceSessionService,
)
from backend.infra.store.store import InMemoryStore

USER = "usr_voice_settle"


class _StubMint:
    def mint_ephemeral_token(self, **kwargs):
        return {
            "token": "authTokens/stub",
            "expires_at": "2026-09-15T00:05:00Z",
            "ws_url": "wss://example.invalid/BidiGenerateContentConstrained",
            "model": "models/stub",
            "voice_id": "Kore",
            "setup": {"setup": {"model": "models/stub"}},
            "setup_timeout_ms": 12_000,
        }


@pytest.fixture
def service() -> VoiceSessionService:
    return VoiceSessionService(
        token_service=_StubMint(),
        store=InMemoryStore(),
        flags=FeatureLifecycleEngine(
            registry=[
                FeatureDefinition(
                    key="voice.realtime", stage=FeatureStage.CANARY, rollout_percentage=100
                )
            ]
        ),
    )


def _mint(service: VoiceSessionService) -> str:
    grant = service.mint(user_id_hash=USER, is_authenticated=True, consent_attested=True)
    return grant["session_id"]


def _age_session(service: VoiceSessionService, session_id: str, seconds: int) -> None:
    """Rewind the session clock so it looks like `seconds` of call have elapsed."""
    from backend.domain.voice.session import VOICE_SESSION_COLLECTION

    record = service.store.get_document(VOICE_SESSION_COLLECTION, session_id)
    now = time.time()
    record["created_at"] = now - seconds
    record["last_event_at"] = now
    record["last_safety_at"] = now
    service.store.set_document(VOICE_SESSION_COLLECTION, session_id, record)


@pytest.mark.parametrize("claimed_reason", sorted(SETUP_FAILURE_REASONS))
def test_client_cannot_buy_back_a_real_call_with_a_setup_failure_reason(
    service: VoiceSessionService, claimed_reason: str
) -> None:
    session_id = _mint(service)
    # The call warms and runs for twenty minutes...
    service.handle_event(
        user_id_hash=USER, payload={"session_id": session_id, "event": "voice.session.warm"}
    )
    _age_session(service, session_id, 1_200)

    # ...then the client claims it never started.
    result = service.teardown(
        user_id_hash=USER, session_id=session_id, reason=claimed_reason, used_s=0
    )

    assert result["used_s"] == pytest.approx(1_200, abs=5)
    usage = service.usage_snapshot(USER)
    assert usage["used_s"] == pytest.approx(1_200, abs=5), "a 20-minute call was refunded in full"
    assert usage["remaining_s"] < DAILY_CAP_SECONDS


def test_a_genuine_setup_failure_is_still_refunded(service: VoiceSessionService) -> None:
    """The protection must not punish the case it was built around."""
    session_id = _mint(service)
    # Never warmed, torn down immediately: this really is a failed setup.
    result = service.teardown(
        user_id_hash=USER, session_id=session_id, reason="setup_timeout", used_s=0
    )
    assert result["used_s"] == 0
    assert result["refund_s"] > 0
    assert service.usage_snapshot(USER)["used_s"] == 0


def test_warmed_call_is_never_a_setup_failure(service: VoiceSessionService) -> None:
    """Even a short call that warmed is a call, not a failed setup."""
    session_id = _mint(service)
    service.handle_event(
        user_id_hash=USER, payload={"session_id": session_id, "event": "voice.session.warm"}
    )
    _age_session(service, session_id, 90)
    result = service.teardown(
        user_id_hash=USER, session_id=session_id, reason="provider_error", used_s=0
    )
    assert result["used_s"] >= 85


def test_teardown_is_idempotent(service: VoiceSessionService) -> None:
    session_id = _mint(service)
    _age_session(service, session_id, 300)
    first = service.teardown(user_id_hash=USER, session_id=session_id, reason="client_hangup")
    second = service.teardown(user_id_hash=USER, session_id=session_id, reason="client_hangup")
    assert first["refund_s"] > 0
    assert second["refund_s"] == 0
    assert second["already_settled"] is True


def test_another_account_cannot_tear_down_this_session(service: VoiceSessionService) -> None:
    session_id = _mint(service)
    with pytest.raises(AppError) as exc:
        service.teardown(user_id_hash="usr_someone_else", session_id=session_id, reason="client_hangup")
    assert exc.value.code == "not_found"


def test_concurrent_mints_cannot_double_hold_the_daily_cap(service: VoiceSessionService) -> None:
    """The hold is a transaction, so the second mint sees the first one's write."""
    from backend.domain.voice.session import VOICE_USAGE_COLLECTION

    _mint(service)
    usage = service.store.get_document(VOICE_USAGE_COLLECTION, USER)
    assert usage["used_s"] <= DAILY_CAP_SECONDS

    # A second Start reclaims the first session rather than stacking a new hold.
    _mint(service)
    usage = service.store.get_document(VOICE_USAGE_COLLECTION, USER)
    assert usage["used_s"] <= DAILY_CAP_SECONDS
