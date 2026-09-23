# tests/backend/voice/test_voice_safety_lease.py
#
# `safety_verified` tells the client that a classifier has looked at what the
# caller said. It used to be a bare timestamp: mint stamped it, and every
# debounce path refreshed it, so a session whose transcript syncs always landed
# on a skip stayed "verified" forever without a single classification. On a
# crisis-support product that is the worst possible thing to be wrong about.

from __future__ import annotations

import time

import pytest

from backend.domain.flags.engine import FeatureLifecycleEngine
from backend.domain.flags.models import FeatureDefinition, FeatureStage
from backend.domain.voice.services.session import (
    SAFETY_STALE_S,
    VOICE_SESSION_COLLECTION,
    VoiceSessionService,
)
from backend.infra.store.store import InMemoryStore

USER = "usr_lease"


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


class _NeverVerifies:
    """A classifier that is up but whose verdicts never come back verified.

    The honest outcome is an unverified session the client keeps retrying — not
    a session that reports itself verified because a debounce refreshed a clock.
    """

    calls = 0

    def classify(self, *_args, **_kwargs):
        type(self).calls += 1
        raise AssertionError("classify must not be reached in these paths")


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


def _record(service: VoiceSessionService, session_id: str) -> dict:
    return service.store.get_document(VOICE_SESSION_COLLECTION, session_id)


def test_a_fresh_silent_session_is_verified(service: VoiceSessionService) -> None:
    """Nobody has spoken, so there is honestly nothing to have classified."""
    record = {"last_safety_at": time.time(), "verified_classifies": 0, "input_ledger": ""}
    assert service._safety_verified(record) is True


def test_speech_without_a_verified_classify_is_not_verified(service: VoiceSessionService) -> None:
    """The exact state the old timestamp-only lease reported as safe."""
    record = {
        "last_safety_at": time.time(),  # freshly stamped by a debounce skip
        "verified_classifies": 0,
        "input_ledger": "i want to die",
    }
    assert service._safety_verified(record) is False


def test_one_verified_classify_earns_the_lease(service: VoiceSessionService) -> None:
    record = {
        "last_safety_at": time.time(),
        "verified_classifies": 1,
        "input_ledger": "i want to die",
    }
    assert service._safety_verified(record) is True


def test_an_earned_lease_still_goes_stale(service: VoiceSessionService) -> None:
    record = {
        "last_safety_at": time.time() - (SAFETY_STALE_S + 5),
        "verified_classifies": 3,
        "input_ledger": "something",
    }
    assert service._safety_verified(record) is False


def test_debounced_syncs_cannot_keep_an_unclassified_call_verified(
    service: VoiceSessionService, monkeypatch
) -> None:
    """Sync speech repeatedly while every classify is debounced away.

    Each sync used to re-stamp the lease. The call must instead report itself
    unverified so the client retries rather than talking on unchecked.
    """
    from backend.domain.voice.services import session as session_mod

    class _AlwaysSkip:
        run = False
        reason = "min_interval"

    monkeypatch.setattr(session_mod, "should_run_classify", lambda **_kw: _AlwaysSkip())
    service.crisis_classifier = _NeverVerifies()

    grant = service.mint(user_id_hash=USER, is_authenticated=True, consent_attested=True)
    session_id = grant["session_id"]
    service.handle_event(
        user_id_hash=USER, payload={"session_id": session_id, "event": "voice.session.warm"}
    )

    last = None
    for turn in range(5):
        last = service.handle_event(
            user_id_hash=USER,
            payload={
                "session_id": session_id,
                "event": "voice.transcript.sync",
                "input_text": f"i have been thinking about ending things {turn}",
                "output_text": "",
            },
        )

    assert _NeverVerifies.calls == 0, "the gate was supposed to skip every call"
    assert _record(service, session_id)["verified_classifies"] == 0
    assert last["safety_verified"] is False


def test_renew_is_refused_while_the_lease_was_never_earned(
    service: VoiceSessionService, monkeypatch
) -> None:
    """A client that never got a verdict does not get a fresh credential."""
    from backend.core.errors import AppError
    from backend.domain.voice.services import session as session_mod

    class _AlwaysSkip:
        run = False
        reason = "min_interval"

    monkeypatch.setattr(session_mod, "should_run_classify", lambda **_kw: _AlwaysSkip())

    grant = service.mint(user_id_hash=USER, is_authenticated=True, consent_attested=True)
    session_id = grant["session_id"]
    service.handle_event(
        user_id_hash=USER, payload={"session_id": session_id, "event": "voice.session.warm"}
    )
    service.handle_event(
        user_id_hash=USER,
        payload={
            "session_id": session_id,
            "event": "voice.transcript.sync",
            "input_text": "i dont want to be here any more",
            "output_text": "",
        },
    )

    with pytest.raises(AppError) as exc:
        service.handle_event(
            user_id_hash=USER, payload={"session_id": session_id, "event": "voice.session.renew"}
        )
    assert exc.value.code == "unavailable"
    assert "safety" in exc.value.message.lower()
