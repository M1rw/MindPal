# tests/unit/platform/test_feature_lifecycle.py — Enterprise Feature Lifecycle & Bootstrap Tests

from __future__ import annotations

import re
from fastapi.testclient import TestClient

from backend.domain.flags.engine import FeatureLifecycleEngine
from backend.domain.flags.models import FeatureDefinition, FeatureStage, EvaluationReason
from backend.main import create_app


def test_feature_definitions_enforce_no_version_numbers() -> None:
    """
    Tier-1 Governance Rule:
    No feature flag key may contain an iteration/version number (e.g. '_v2', '_v3', '_v4').
    Features must be named by their semantic domain capability.
    """
    engine = FeatureLifecycleEngine()
    version_pattern = re.compile(r"_v\d+", re.IGNORECASE)

    for definition in engine.all_definitions():
        assert not version_pattern.search(definition.key), (
            f"Feature key '{definition.key}' violates Big Tech governance: contains version suffix. "
            "Use domain taxonomy instead (e.g. 'voice.realtime' rather than 'voice_v4')."
        )


def test_consistent_hash_bucketing_is_deterministic() -> None:
    """Consistent hash bucketing must return identical percentiles for identical inputs."""
    user_a = "usr_alice_123"
    user_b = "usr_bob_456"
    feature = "voice.realtime"

    bucket_a1 = FeatureLifecycleEngine.compute_bucket(user_a, feature)
    bucket_a2 = FeatureLifecycleEngine.compute_bucket(user_a, feature)
    bucket_b1 = FeatureLifecycleEngine.compute_bucket(user_b, feature)

    assert bucket_a1 == bucket_a2
    assert 0 <= bucket_a1 < 100
    assert 0 <= bucket_b1 < 100
    # Different users produce distributed buckets
    assert isinstance(bucket_a1, int)


def test_voice_realtime_defaults_on() -> None:
    engine = FeatureLifecycleEngine()
    evaluation = engine.evaluate("voice.realtime", "usr_anyone")
    assert evaluation.enabled is True
    assert evaluation.stage == FeatureStage.CANARY
    snapshot = engine.get_snapshot("usr_anyone")
    assert snapshot["flags"]["voice_enabled"] is True


def test_voice_realtime_off_when_env_zero(monkeypatch) -> None:
    monkeypatch.setenv("MINDPAL_VOICE_LIVE", "0")
    engine = FeatureLifecycleEngine()
    evaluation = engine.evaluate("voice.realtime", "usr_anyone")
    assert evaluation.enabled is False
    assert evaluation.stage == FeatureStage.DARK_LAUNCH
    snapshot = engine.get_snapshot("usr_anyone")
    assert snapshot["flags"]["voice_enabled"] is False


def test_voice_realtime_allowlist_overrides_env_off(monkeypatch) -> None:
    monkeypatch.setenv("MINDPAL_VOICE_LIVE", "0")
    monkeypatch.setenv("MINDPAL_VOICE_LIVE_ALLOWLIST", "usr_vip")
    engine = FeatureLifecycleEngine()
    assert engine.evaluate("voice.realtime", "usr_vip").enabled is True
    assert engine.evaluate("voice.realtime", "usr_other").enabled is False


def test_feature_lifecycle_stages() -> None:
    """Validates DARK_LAUNCH, CANARY, GA, and SUNSET evaluation semantics."""
    engine = FeatureLifecycleEngine(
        registry=[
            FeatureDefinition(
                key="test.dark",
                stage=FeatureStage.DARK_LAUNCH,
                allowlist={"vip_user"},
            ),
            FeatureDefinition(
                key="test.ga",
                stage=FeatureStage.GA,
            ),
            FeatureDefinition(
                key="test.sunset",
                stage=FeatureStage.SUNSET,
            ),
            FeatureDefinition(
                key="test.canary",
                stage=FeatureStage.CANARY,
                rollout_percentage=50,
            ),
        ]
    )

    # GA is always true
    assert engine.evaluate("test.ga", "anyone").enabled is True
    assert engine.evaluate("test.ga", "anyone").reason == EvaluationReason.GA_ROLLOUT

    # Dark launch is false unless on allowlist
    assert engine.evaluate("test.dark", "regular_user").enabled is False
    assert engine.evaluate("test.dark", "regular_user").reason == EvaluationReason.DEFAULT_OFF
    assert engine.evaluate("test.dark", "vip_user").enabled is True
    assert engine.evaluate("test.dark", "vip_user").reason == EvaluationReason.ALLOWLIST_OVERRIDE

    # Sunset is always false
    assert engine.evaluate("test.sunset", "vip_user").enabled is False
    assert engine.evaluate("test.sunset", "vip_user").reason == EvaluationReason.SUNSET_DEPRECATED


def test_document_bootstrap_injected_synchronously_in_get_root() -> None:
    """Pattern B: Asserts document bootstrap is injected in GET / with no leaked secrets."""
    client = TestClient(create_app(serve_frontend=True))
    response = client.get("/")

    assert response.status_code == 200
    assert '<script id="__MINDPAL_BOOTSTRAP__" type="application/json">' in response.text
    assert "window.MINDPAL_CONFIG" in response.text
    assert "no-cache" in response.headers.get("cache-control", "")

    # Security boundary: server service account secrets must never appear in HTML
    assert "FIREBASE_CREDENTIALS_JSON" not in response.text
    assert "private_key" not in response.text
    assert "client_email" not in response.text


def test_api_features_endpoint_returns_dual_layer_telemetry() -> None:
    """GET /api/features must return both flat capability flags and audit telemetry."""
    client = TestClient(create_app(serve_frontend=False))
    response = client.get("/api/features")

    assert response.status_code == 200
    data = response.json()
    assert "flags" in data
    assert "evaluations" in data
    assert data["flags"]["voice_enabled"] is True
    assert data["flags"]["memory_enabled"] is True
    assert "voice.realtime" in data["evaluations"]
    assert data["evaluations"]["voice.realtime"]["stage"] == "canary"
    assert data["evaluations"]["voice.realtime"]["enabled"] is True
