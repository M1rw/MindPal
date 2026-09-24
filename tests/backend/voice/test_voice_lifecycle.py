from __future__ import annotations

import time

import pytest

from backend.core.errors import AppError
from backend.domain.voice.providers.live import LiveVoiceCapabilities, LiveVoiceHealth
from backend.domain.voice.providers.live import LiveVoiceCircuit, LiveVoiceProviderRouter
from backend.domain.voice.privacy import VoicePrivacyService
from backend.domain.voice.services.session import (
    VOICE_ACTIVE_COLLECTION,
    VOICE_SESSION_COLLECTION,
    VoiceSessionService,
)
from backend.infra.store.providers.memory import InMemoryStore


class FakeLiveProvider:
    name = "fake"

    def __init__(self) -> None:
        self.calls = 0
        self.circuit = LiveVoiceCircuit()

    def capabilities(self) -> LiveVoiceCapabilities:
        return LiveVoiceCapabilities(True, True, True, True, True, True, True, ("Test",))

    def health(self) -> LiveVoiceHealth:
        circuit = "open" if self.circuit.opened_at > 0 else "closed"
        return LiveVoiceHealth("fake", "healthy", circuit, fallback_eligible=True)

    def mint(self, **_kwargs: object) -> dict[str, object]:
        self.calls += 1
        return {
            "token": f"token-{self.calls}",
            "expires_at": "2099-01-01T00:00:00Z",
            "new_session_expires_at": "2099-01-01T00:00:00Z",
            "ws_url": "wss://example.test/live",
            "model": "fake-live",
            "voice_id": "Test",
            "setup": {"setup": {}},
            "setup_timeout_ms": 1000,
        }


@pytest.fixture(autouse=True)
def allow_in_memory_voice(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        VoiceSessionService,
        "_production_requires_durable_store",
        staticmethod(lambda: False),
    )


def service() -> tuple[VoiceSessionService, InMemoryStore, FakeLiveProvider]:
    store = InMemoryStore()
    provider = FakeLiveProvider()
    return VoiceSessionService(store=store, provider=provider), store, provider


def test_voice_lifecycle_mint_warm_renew_teardown() -> None:
    voice, store, provider = service()
    grant = voice.mint(user_id_hash="usr_flow", is_authenticated=True, consent_attested=True)
    session_id = grant["session_id"]

    warm = voice.handle_event(
        user_id_hash="usr_flow",
        payload={"session_id": session_id, "event": "voice.session.warm", "t_setup_ms": 20},
    )
    renewed = voice.handle_event(
        user_id_hash="usr_flow",
        payload={"session_id": session_id, "event": "voice.session.renew"},
    )
    ended = voice.handle_event(
        user_id_hash="usr_flow",
        payload={"session_id": session_id, "event": "voice.session.teardown", "reason": "client_hangup"},
    )

    assert warm["ok"] and renewed["ok"] and ended["action"] == "torn_down"
    assert provider.calls == 2
    assert store.get_document(VOICE_SESSION_COLLECTION, session_id)["status"] == "torn_down"


def test_voice_quota_exhaustion_is_server_enforced() -> None:
    voice, store, _provider = service()
    store.set_document(
        "voice_minute_reservations",
        "usr_quota",
        {"user_id_hash": "usr_quota", "day": time.strftime("%Y-%m-%d", time.gmtime()), "used_s": 1800},
    )

    with pytest.raises(AppError) as error:
        voice.mint(user_id_hash="usr_quota", is_authenticated=True, consent_attested=True)

    assert error.value.code == "quota_exceeded"


def test_voice_safety_escalation_freezes_session() -> None:
    voice, store, _provider = service()
    grant = voice.mint(user_id_hash="usr_safety", is_authenticated=True, consent_attested=True)
    response = voice.handle_event(
        user_id_hash="usr_safety",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.safety.crisis",
            "reason": "client_local_evidence",
            "source": "client",
        },
    )

    assert response["action"] == "escalate_pause"
    assert store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])["status"] == "crisis_freeze"


def test_voice_abandoned_active_session_is_reclaimed_before_new_mint() -> None:
    voice, store, _provider = service()
    old_session = {
        "session_id": "vs_old",
        "user_id_hash": "usr_reclaim",
        "status": "minted",
        "floor": "idle",
        "created_at": time.time() - 1000,
        "reserved_s": 1800,
        "setup_complete": False,
        "last_safety_at": time.time() - 1000,
    }
    store.set_document(VOICE_SESSION_COLLECTION, "vs_old", old_session)
    store.set_document(VOICE_ACTIVE_COLLECTION, "usr_reclaim", {"session_id": "vs_old"})

    grant = voice.mint(user_id_hash="usr_reclaim", is_authenticated=True, consent_attested=True)

    assert grant["session_id"] != "vs_old"
    assert store.get_document(VOICE_SESSION_COLLECTION, "vs_old")["status"] == "torn_down"


def test_voice_duplicate_event_replays_original_response() -> None:
    voice, store, _provider = service()
    grant = voice.mint(user_id_hash="usr_duplicate", is_authenticated=True, consent_attested=True)
    payload = {"session_id": grant["session_id"], "event": "voice.session.warm", "t_setup_ms": 12}

    first = voice.handle_event(user_id_hash="usr_duplicate", payload=payload, idempotency_key="warm-1")
    second = voice.handle_event(user_id_hash="usr_duplicate", payload=payload, idempotency_key="warm-1")

    assert first == second
    assert store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])["t_setup_ms"] == 12


def test_provider_router_falls_back_when_primary_circuit_is_open() -> None:
    primary = FakeLiveProvider()
    fallback = FakeLiveProvider()
    primary.name = "primary"
    fallback.name = "fallback"
    primary.circuit = LiveVoiceCircuit(failure_threshold=1)
    primary.circuit.failure("provider down", time.time())

    result = LiveVoiceProviderRouter((primary, fallback)).mint()

    assert result["token"] == "token-1"
    assert fallback.calls == 1


def test_voice_privacy_worker_purges_expired_data_and_exports_no_raw_transcript() -> None:
    store = InMemoryStore()
    store.set_document(
        "voice_sessions",
        "vs_expired",
        {"session_id": "vs_expired", "user_id_hash": "usr_privacy", "expires_at": 10, "input_transcript": "private"},
    )
    store.set_document(
        "voice_active_sessions",
        "usr_privacy",
        {"user_id_hash": "usr_privacy", "session_id": "vs_expired"},
    )
    privacy = VoicePrivacyService(store)

    export = privacy.export_account("usr_privacy")
    removed = privacy.purge_expired(now=20)

    assert export["policy"]["raw_transcripts"] == "not_exported"
    assert "input_transcript" not in export["sessions"][0]
    assert removed["voice_sessions"] == 1
    assert removed["voice_active_sessions"] == 1


def test_a_renewed_socket_is_the_same_call_voice_language_and_style() -> None:
    """Renew used to mint with only a resumption handle, so the voice changed mid-call."""
    store = InMemoryStore()
    seen: list[dict] = []

    class Recording(FakeLiveProvider):
        def mint(self, **kwargs: object) -> dict[str, object]:
            seen.append(dict(kwargs))
            return super().mint(**kwargs)

    voice = VoiceSessionService(store=store, provider=Recording())
    grant = voice.mint(
        user_id_hash="usr_same",
        is_authenticated=True,
        consent_attested=True,
        voice_id="Puck",
        voice_language="ar",
        personalization={"baseStyle": "concise", "warmth": "direct"},
    )
    voice.handle_event(user_id_hash="usr_same", payload={"session_id": grant["session_id"], "event": "voice.session.warm"})
    voice.handle_event(user_id_hash="usr_same", payload={"session_id": grant["session_id"], "event": "voice.session.renew"})
    first, renewed = seen[0], seen[1]
    assert renewed["voice_id"] == first["voice_id"] == "Puck"
    assert renewed["voice_language"] == "ar"
    assert renewed["personalization"] == first["personalization"]
    assert renewed["personalization"]["baseStyle"] == "concise"
