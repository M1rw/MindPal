from __future__ import annotations

import hashlib
import json
import time

import pytest

from backend.core.errors import AppError
from backend.domain.identity.identity import IdentityService
from backend.infra.llm.gateway import LLMGateway, LLMGatewayError
from backend.infra.observability.metrics import VoiceMetric, provider_metrics, voice_metrics
from backend.infra.observability.metrics import StoreMetricsExporter, VoiceMetrics
from backend.models.provider_outputs import VoiceReactionOutput
from backend.domain.quota.quota import QuotaService
from backend.domain.voice.analytics import VoiceAnalyticsService
from backend.domain.voice.policy import resolve_voice_policy
from backend.domain.voice.telemetry import VoiceTelemetryService
from backend.domain.voice.services.session import (
    VOICE_EVENT_IDEMPOTENCY_COLLECTION,
    VOICE_SESSION_COLLECTION,
    VoiceSessionService,
)
from backend.infra.store.providers.memory import InMemoryStore
from backend.infra.auth.verifier import guest_session
from backend.http import voice_ops as voice_http


def test_quota_replay_is_never_free() -> None:
    """A reused Idempotency-Key must not unlock unlimited uncharged turns."""
    store = InMemoryStore()
    quota = QuotaService(store=store)

    assert quota.reserve("usr_one", 1, idempotency_key="chat-1", request_digest="m1").allowed is True
    for _ in range(100):
        with pytest.raises(AppError) as replay:
            quota.reserve("usr_one", 1, idempotency_key="chat-1", request_digest="m1")
        assert replay.value.code == "conflict"
    assert quota.snapshot("usr_one").credits_5h == 1

    with pytest.raises(AppError) as different:
        quota.reserve("usr_one", 1, idempotency_key="chat-1", request_digest="another message")
    assert different.value.code == "conflict"


def test_refunded_turn_can_be_retried_with_the_same_key() -> None:
    store = InMemoryStore()
    quota = QuotaService(store=store)
    assert quota.reserve("usr_one", 1, idempotency_key="chat-1", request_digest="m1").allowed
    quota.refund_quota("usr_one", 1, idempotency_key="chat-1")
    assert quota.reserve("usr_one", 1, idempotency_key="chat-1", request_digest="m1").allowed
    assert quota.snapshot("usr_one").credits_5h == 1


def test_anonymous_replay_is_never_free() -> None:
    quota = QuotaService(store=InMemoryStore())
    assert quota.reserve_anonymous("203.0.113.9", 1, idempotency_key="k", request_digest="m").allowed
    with pytest.raises(AppError):
        quota.reserve_anonymous("203.0.113.9", 1, idempotency_key="k", request_digest="m")


def test_voice_event_rejects_a_concurrent_claim() -> None:
    store = InMemoryStore()
    service = VoiceSessionService(store=store)
    payload = {"session_id": "vs_one", "event": "voice.session.warm", "t_setup_ms": 42}
    key = "event-1"
    fingerprint = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()
    record_id = hashlib.sha256(f"usr_one:vs_one:{key}".encode()).hexdigest()
    store.set_document(
        VOICE_EVENT_IDEMPOTENCY_COLLECTION,
        record_id,
        {
            "user_id_hash": "usr_one",
            "session_id": "vs_one",
            "key": key,
            "fingerprint": fingerprint,
            "completed": False,
            "owner_token": "other-request",
            "processing_until": time.time() + 60,
        },
    )

    with pytest.raises(AppError) as conflict:
        service.handle_event(user_id_hash="usr_one", payload=payload, idempotency_key=key)
    assert conflict.value.code == "conflict"


def test_invalid_structured_output_records_contract_failure() -> None:
    gateway = LLMGateway.__new__(LLMGateway)
    gateway.generate_json = lambda **_: '{"reaction":"invalid"}'
    snapshot_before = provider_metrics().snapshot()
    before = snapshot_before.get(
        "gemini.structured_contract.failure",
        snapshot_before.get("openrouter.structured_contract.failure", 0),
    )

    with pytest.raises(LLMGatewayError) as error:
        gateway.generate_structured(contract=VoiceReactionOutput, prompt="test")

    assert error.value.code == "invalid_provider_output"
    provider = next(
        (name for name in provider_metrics().snapshot() if name.endswith(".structured_contract.failure")),
        None,
    )
    assert provider is not None, provider_metrics().snapshot()
    assert provider_metrics().snapshot()[provider] == before + 1


def test_voice_event_retries_return_the_original_response() -> None:
    store = InMemoryStore()
    service = VoiceSessionService(store=store)
    store.set_document(
        VOICE_SESSION_COLLECTION,
        "vs_one",
        {"session_id": "vs_one", "user_id_hash": "usr_one", "status": "minted", "floor": "idle"},
    )
    payload = {"session_id": "vs_one", "event": "voice.session.warm", "t_setup_ms": 42}

    first = service.handle_event(user_id_hash="usr_one", payload=payload, idempotency_key="event-1")
    second = service.handle_event(user_id_hash="usr_one", payload=payload, idempotency_key="event-1")

    assert first == second
    assert store.get_document(VOICE_SESSION_COLLECTION, "vs_one")["t_setup_ms"] == 42


def test_voice_policy_enforces_guest_and_standard_limits() -> None:
    guest_policy = resolve_voice_policy(is_authenticated=False, guest_id="guest-device-123")
    signed_in_policy = resolve_voice_policy(is_authenticated=True, guest_id="")

    assert guest_policy.max_session_seconds == 300
    assert guest_policy.daily_cap_seconds == 300
    assert guest_policy.session_mode == "guest"
    assert signed_in_policy.max_session_seconds == 1800
    assert signed_in_policy.daily_cap_seconds == 1800
    assert signed_in_policy.session_mode == "account"


def test_voice_telemetry_records_session_events() -> None:
    store = InMemoryStore()
    service = VoiceTelemetryService(store=store)

    event = service.record_event(
        user_id_hash="usr_voice_123",
        session_id="vs_telemetry_1",
        event_name="voice.session.warm",
        source="client",
        reason="startup_complete",
        outcome="ok",
        duration_ms=120,
        metadata={"t_setup_ms": 120},
    )

    assert event["event"] == "voice.session.warm"
    assert event["session_id"] == "vs_telemetry_1"
    assert event["user_id_hash"] == "usr_voice_123"
    assert len(store.list_documents("voice_telemetry")) == 1


def test_voice_usage_snapshot_exposes_account_policy() -> None:
    service = VoiceSessionService(store=InMemoryStore())

    snapshot = service.usage_snapshot("usr_policy_123")

    assert snapshot["session_mode"] == "account"
    assert snapshot["quota_label"] == "account"
    assert snapshot["max_session_seconds"] == 1800
    assert snapshot["daily_cap_seconds"] == 1800
    assert "30 minutes" in snapshot["quota_message"]


def test_voice_session_service_emits_warm_telemetry() -> None:
    store = InMemoryStore()
    service = VoiceSessionService(store=store)
    store.set_document(
        VOICE_SESSION_COLLECTION,
        "vs_telemetry_integrated",
        {"session_id": "vs_telemetry_integrated", "user_id_hash": "usr_one", "status": "minted", "floor": "idle"},
    )

    service.handle_event(
        user_id_hash="usr_one",
        payload={"session_id": "vs_telemetry_integrated", "event": "voice.session.warm", "t_setup_ms": 42},
    )

    events = store.list_documents("voice_telemetry")
    assert any(e.get("event") == "voice.session.warm" and e.get("session_id") == "vs_telemetry_integrated" for e in events)


def test_voice_analytics_rolls_up_session_summary() -> None:
    store = InMemoryStore()
    telemetry = VoiceTelemetryService(store=store)
    telemetry.record_event(
        user_id_hash="usr_analytics_1",
        session_id="vs_analytics_1",
        event_name="voice.session.mint",
        source="server",
        reason="session_created",
        outcome="ok",
        duration_ms=100,
    )
    telemetry.record_event(
        user_id_hash="usr_analytics_1",
        session_id="vs_analytics_1",
        event_name="voice.session.warm",
        source="client",
        reason="startup_complete",
        outcome="ok",
        duration_ms=42,
    )
    telemetry.record_event(
        user_id_hash="usr_analytics_1",
        session_id="vs_analytics_1",
        event_name="voice.session.teardown",
        source="server",
        reason="client_hangup",
        outcome="ok",
        duration_ms=5000,
    )

    summary = VoiceAnalyticsService(store=store).summarize_session("usr_analytics_1", "vs_analytics_1")

    assert summary["session_id"] == "vs_analytics_1"
    assert summary["event_count"] == 3
    assert summary["outcomes"]["ok"] == 3
    assert summary["duration_ms_total"] >= 5142
    assert "voice.session.teardown" in summary["events_by_name"]


def test_voice_analytics_exposes_session_audit_metadata() -> None:
    store = InMemoryStore()
    session_id = "vs_audit_2"
    store.set_document(
        "voice_sessions",
        session_id,
        {
            "session_id": session_id,
            "user_id_hash": "usr_audit_2",
            "status": "stay_support",
            "floor": "listening",
            "session_mode": "account",
            "last_risk_band": "support",
            "danger_kind": "distress",
            "reserved_s": 1800,
            "used_s": 240,
            "created_at": 1710000000,
        },
    )

    telemetry = VoiceTelemetryService(store=store)
    telemetry.record_event(
        user_id_hash="usr_audit_2",
        session_id=session_id,
        event_name="voice.safety.risk_rating",
        source="client",
        reason="support",
        outcome="ok",
        duration_ms=80,
        metadata={"band": "support", "danger_kind": "distress", "risk": 6.5},
    )
    telemetry.record_event(
        user_id_hash="usr_audit_2",
        session_id=session_id,
        event_name="voice.session.teardown",
        source="server",
        reason="client_hangup",
        outcome="ok",
        duration_ms=1500,
    )

    audit = VoiceAnalyticsService(store=store).audit_session("usr_audit_2", session_id)

    assert audit["session"]["status"] == "stay_support"
    assert audit["session"]["session_mode"] == "account"
    assert audit["risk"]["max_risk_band"] == "support"
    assert audit["risk"]["danger_kind"] == "distress"
    assert audit["events_by_name"]["voice.session.teardown"] == 1


def test_voice_audit_is_owner_scoped() -> None:
    store = InMemoryStore()
    store.set_document(
        VOICE_SESSION_COLLECTION,
        "vs_private",
        {"session_id": "vs_private", "user_id_hash": "usr_owner", "status": "warm"},
    )

    audit = VoiceAnalyticsService(store=store).audit_session("usr_other", "vs_private")

    assert audit["session"]["status"] == "missing"
    assert audit["timeline"] == []


def test_voice_telemetry_allowlists_metadata() -> None:
    store = InMemoryStore()
    event = VoiceTelemetryService(store=store).record_event(
        user_id_hash="usr_private",
        session_id="vs_private",
        event_name="voice.session.warm",
        metadata={"risk": 2, "transcript": "private words", "nested": {"secret": True}},
    )

    assert event["metadata"] == {"risk": 2}
    assert event["expires_at"] > event["ts"]


def test_identity_deletion_removes_voice_records() -> None:
    store = InMemoryStore()
    user_id = "usr_delete_voice"
    store.set_document("voice_sessions", "vs_delete", {"session_id": "vs_delete", "user_id_hash": user_id})
    telemetry = VoiceTelemetryService(store=store)
    telemetry.record_event(user_id_hash=user_id, session_id="vs_delete", event_name="voice.session.warm")
    store.set_document(
        "voice_event_idempotency",
        hashlib.sha256(f"{user_id}:vs_delete:key-1".encode()).hexdigest(),
        {"user_id_hash": user_id, "session_id": "vs_delete", "key": "key-1"},
    )
    identity = IdentityService.__new__(IdentityService)
    identity.store = store

    identity.delete_account(user_id)

    assert store.list_documents("voice_sessions") == []
    assert store.list_documents("voice_telemetry") == []
    assert store.list_documents("voice_event_idempotency") == []


def test_voice_metrics_keep_low_cardinality_labels() -> None:
    metrics = voice_metrics()
    metrics.record(VoiceMetric(operation="session-token", duration_ms=12, outcome="success", status_code=200))

    snapshot = metrics.snapshot()

    assert snapshot["session-token.success"] >= 1
    assert snapshot["session-token.duration_ms"] >= 12


def test_voice_http_protected_routes_reject_guests(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(voice_http, "verify_auth_header", lambda _authorization: guest_session())

    with pytest.raises(AppError) as usage_error:
        voice_http.get_voice_usage()
    with pytest.raises(AppError) as audit_error:
        voice_http.get_voice_session_audit(session_id="vs_private")

    assert usage_error.value.code == "unauthenticated"
    assert audit_error.value.code == "unauthenticated"


def test_voice_runtime_policy_is_typed_and_centralized() -> None:
    from backend.configs.runtime import voice_runtime_settings

    config = voice_runtime_settings()

    assert config.policy.guest_daily_cap_seconds == 300
    assert config.policy.account_daily_cap_seconds == 1800
    assert config.session.retention_seconds >= 86400


def test_metrics_exporter_persists_bounded_events_and_is_failure_isolated() -> None:
    store = InMemoryStore()
    metrics = VoiceMetrics(exporter=StoreMetricsExporter(store))
    metrics.record(VoiceMetric(operation="audit", duration_ms=7, outcome="success", status_code=200))

    exported = store.list_documents("observability_metrics")
    assert len(exported) == 1
    assert exported[0]["operation"] == "audit"
    assert "transcript" not in exported[0]

    class BrokenExporter:
        def export(self, _metric_type: str, _payload: dict[str, object]) -> None:
            raise RuntimeError("sink unavailable")

    resilient = VoiceMetrics(exporter=BrokenExporter())
    resilient.record(VoiceMetric(operation="audit", duration_ms=1, outcome="success", status_code=200))
    assert resilient.snapshot()["audit.success"] == 1
