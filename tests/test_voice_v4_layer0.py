from __future__ import annotations

import json

from backend.models.feature_flags import FeatureEvaluation, FeatureLifecycle, FeatureReason
from backend.models.voice_v4_layer0 import (
    VOICE_V4_CONTRACT,
    VOICE_V4_FEATURE_KEY,
    SafeVoiceDiagnostic,
    VoiceV4Environment,
    VoiceV4ReleaseReason,
    build_safe_voice_diagnostic,
    evaluate_voice_v4_release,
)


def feature(*, key: str = VOICE_V4_FEATURE_KEY, enabled: bool = True, lifecycle: FeatureLifecycle = FeatureLifecycle.PREVIEW) -> FeatureEvaluation:
    return FeatureEvaluation(
        key=key,
        title="Live voice",
        description="Preview",
        lifecycle=lifecycle,
        enabled=enabled,
        reason=FeatureReason.ENABLED if enabled else FeatureReason.DISABLED,
        user_visible=True,
        user_toggleable=False,
        safety_critical=False,
        version=1,
    )


def test_layer0_contract_is_audio_only_and_excludes_future_runtime_features() -> None:
    assert VOICE_V4_CONTRACT.feature_key == VOICE_V4_FEATURE_KEY
    assert VOICE_V4_CONTRACT.input_audio.sample_rate_hz == 16_000
    assert VOICE_V4_CONTRACT.output_audio.sample_rate_hz == 24_000
    assert VOICE_V4_CONTRACT.input_audio.encoding == "PCM16LE"
    assert VOICE_V4_CONTRACT.output_audio.encoding == "PCM16LE"
    assert VOICE_V4_CONTRACT.baseline.tools is False
    assert VOICE_V4_CONTRACT.baseline.memory is False
    assert VOICE_V4_CONTRACT.baseline.dynamic_affect is False
    assert VOICE_V4_CONTRACT.baseline.reconnect is False
    assert VOICE_V4_CONTRACT.baseline.session_resumption is False


def test_release_gate_requires_explicit_approval_and_never_allows_production() -> None:
    assert evaluate_voice_v4_release(feature(), environment="preview", explicit_approval=False).reason is VoiceV4ReleaseReason.APPROVAL_REQUIRED

    preview = evaluate_voice_v4_release(feature(), environment="preview", explicit_approval=True)
    assert preview.allowed is True
    assert preview.environment is VoiceV4Environment.PREVIEW

    production = evaluate_voice_v4_release(feature(), environment="production", explicit_approval=True)
    assert production.allowed is False
    assert production.reason is VoiceV4ReleaseReason.PRODUCTION_GUARD


def test_release_gate_fails_closed_for_missing_disabled_and_invalid_features() -> None:
    assert evaluate_voice_v4_release(None, environment="preview", explicit_approval=True).reason is VoiceV4ReleaseReason.FEATURE_MISSING
    assert evaluate_voice_v4_release(feature(enabled=False), environment="preview", explicit_approval=True).reason is VoiceV4ReleaseReason.FEATURE_DISABLED
    assert evaluate_voice_v4_release(feature(lifecycle=FeatureLifecycle.MAINTENANCE), environment="preview", explicit_approval=True).reason is VoiceV4ReleaseReason.FEATURE_LIFECYCLE_BLOCKED
    assert evaluate_voice_v4_release(feature(key="chat.standard_model"), environment="preview", explicit_approval=True).reason is VoiceV4ReleaseReason.WRONG_FEATURE
    assert evaluate_voice_v4_release(feature(), environment="unknown", explicit_approval=True).reason is VoiceV4ReleaseReason.INVALID_ENVIRONMENT


def test_safe_diagnostics_discard_private_and_unknown_fields() -> None:
    payload = {
        "session_id": "vs_12345678",
        "event": "playback_snapshot",
        "state": "ASSISTANT_SPEAKING",
        "generation": 3,
        "queue_depth_ms": 640,
        "error_code": "provider_unavailable",
        "token": "secret-token-value",
        "authorization": "Bearer secret-token-value",
        "provider_url": "wss://provider.invalid/private",
        "pcm": "raw-audio-bytes",
        "transcript": "private transcript",
        "prompt": "private prompt",
    }

    result = build_safe_voice_diagnostic(payload)
    serialized = json.dumps(result)

    assert result == {
        "session_id": "vs_12345678",
        "event": "playback_snapshot",
        "state": "ASSISTANT_SPEAKING",
        "generation": 3,
        "queue_depth_ms": 640,
        "error_code": "provider_unavailable",
    }
    assert "secret-token-value" not in serialized
    assert "provider.invalid" not in serialized
    assert "raw-audio-bytes" not in serialized
    assert "private transcript" not in serialized
    assert "private prompt" not in serialized


def test_invalid_diagnostic_values_fail_closed_to_safe_defaults() -> None:
    result = build_safe_voice_diagnostic({
        "event": "raw_provider_event",
        "state": "SOME_UNKNOWN_STATE",
        "audio_context_state": "unexpected",
        "message_category": "private_provider_payload",
        "generation": -1,
    })

    assert result == {"event": "unknown"}
    assert SafeVoiceDiagnostic().model_dump(exclude_none=True) == {"event": "unknown"}
