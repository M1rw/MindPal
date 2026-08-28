from datetime import UTC, datetime, timedelta

import pytest

from backend.models.feature_flags import (
    FeatureContext,
    FeatureLifecycle,
    FeaturePolicy,
    FeatureReason,
)
from backend.services.feature_flags_service import FeatureFlagsService


NOW = datetime(2026, 8, 27, 12, 0, tzinfo=UTC)


def context(**overrides: object) -> FeatureContext:
    values = {
        "user_id_hash": "usr_11111111111111111111111111111111",
        "authenticated": True,
        "channel": "web",
        "locale": "en",
        "now_utc": NOW,
    }
    values.update(overrides)
    return FeatureContext(**values)


def test_builtin_registry_has_safe_voice_default_and_public_shape() -> None:
    service = FeatureFlagsService()
    result = service.evaluate("voice.live_v4", context())

    assert result.enabled is False
    assert result.lifecycle is FeatureLifecycle.DISABLED
    assert result.reason is FeatureReason.DISABLED
    assert result.to_public_dict() == {
        "key": "voice.live_v4",
        "title": "Live voice",
        "description": "Future full-duplex voice experience.",
        "lifecycle": "disabled",
        "enabled": False,
        "reason": "disabled",
        "user_visible": True,
        "user_toggleable": False,
        "safety_critical": False,
        "fallback_key": "chat.standard_model",
        "replacement_key": None,
        "version": 1,
    }


def test_unknown_feature_fails_closed() -> None:
    result = FeatureFlagsService().evaluate("future.missing", context())

    assert result.enabled is False
    assert result.reason is FeatureReason.UNKNOWN_FEATURE
    assert result.user_visible is False


def test_authentication_is_required_before_rollout_or_default_access() -> None:
    service = FeatureFlagsService(
        policies={"chat.pro_model": FeaturePolicy(key="chat.pro_model", enabled=True)}
    )

    result = service.evaluate("chat.pro_model", context(authenticated=False, user_id_hash=None))

    assert result.enabled is False
    assert result.reason is FeatureReason.REQUIRES_AUTHENTICATION


def test_maintenance_and_disabled_lifecycle_always_deny() -> None:
    service = FeatureFlagsService(
        policies={
            "chat.standard_model": FeaturePolicy(
                key="chat.standard_model",
                lifecycle=FeatureLifecycle.MAINTENANCE,
                enabled=True,
            )
        }
    )

    result = service.evaluate("chat.standard_model", context())

    assert result.enabled is False
    assert result.lifecycle is FeatureLifecycle.MAINTENANCE
    assert result.reason is FeatureReason.MAINTENANCE


def test_explicit_deny_wins_over_allow_and_admin() -> None:
    service = FeatureFlagsService(
        policies={
            "chat.standard_model": FeaturePolicy(
                key="chat.standard_model",
                enabled=True,
                allow_user_hashes=["usr_11111111111111111111111111111111"],
                deny_user_hashes=["usr_22222222222222222222222222222222"],
            )
        }
    )

    denied = service.evaluate("chat.standard_model", context(user_id_hash="usr_22222222222222222222222222222222", is_admin=True))
    allowed = service.evaluate("chat.standard_model", context(user_id_hash="usr_11111111111111111111111111111111"))

    assert denied.enabled is False
    assert denied.reason is FeatureReason.EXPLICIT_DENY
    assert allowed.enabled is True


def test_admin_can_access_targeted_preview_when_policy_allows_admins() -> None:
    service = FeatureFlagsService(
        policies={
            "mental_health.insights": FeaturePolicy(
                key="mental_health.insights",
                lifecycle=FeatureLifecycle.PREVIEW,
                enabled=True,
                rollout_percentage=0,
            )
        }
    )

    result = service.evaluate("mental_health.insights", context(is_admin=True))

    assert result.enabled is True
    assert result.reason is FeatureReason.ENABLED_FOR_ADMIN


def test_percentage_rollout_is_stable_and_bounded() -> None:
    service = FeatureFlagsService(
        policies={
            "chat.standard_model": FeaturePolicy(
                key="chat.standard_model",
                enabled=True,
                rollout_percentage=50,
            )
        }
    )

    first = service.evaluate("chat.standard_model", context())
    second = service.evaluate("chat.standard_model", context())

    assert first.enabled is second.enabled
    assert first.reason is second.reason
    assert first.reason in {FeatureReason.ENABLED, FeatureReason.NOT_IN_ROLLOUT}


def test_anonymous_users_do_not_receive_user_hash_overrides() -> None:
    service = FeatureFlagsService(
        policies={
            "chat.standard_model": FeaturePolicy(
                key="chat.standard_model",
                enabled=False,
                allow_user_hashes=["usr_11111111111111111111111111111111"],
            )
        }
    )

    result = service.evaluate(
        "chat.standard_model",
        context(authenticated=False, user_id_hash="usr_11111111111111111111111111111111"),
    )

    assert result.enabled is False
    assert result.reason is FeatureReason.DISABLED


def test_schedule_blocks_before_start_and_after_end() -> None:
    service = FeatureFlagsService(
        policies={
            "chat.standard_model": FeaturePolicy(
                key="chat.standard_model",
                enabled=True,
                starts_at_utc=NOW + timedelta(hours=1),
                ends_at_utc=NOW + timedelta(hours=2),
            )
        }
    )

    before = service.evaluate("chat.standard_model", context(now_utc=NOW))
    after = service.evaluate("chat.standard_model", context(now_utc=NOW + timedelta(hours=3)))

    assert before.reason is FeatureReason.NOT_STARTED
    assert after.reason is FeatureReason.EXPIRED
    assert not before.enabled and not after.enabled


def test_prerequisite_must_be_enabled() -> None:
    service = FeatureFlagsService(
        policies={
            "chat.pro_model": FeaturePolicy(
                key="chat.pro_model",
                enabled=True,
                prerequisites=["voice.live_v4"],
            )
        }
    )

    result = service.evaluate("chat.pro_model", context())

    assert result.enabled is False
    assert result.reason is FeatureReason.PREREQUISITE_DISABLED


def test_safety_critical_feature_cannot_be_disabled_by_policy() -> None:
    service = FeatureFlagsService(
        policies={
            "security.crisis_interception": FeaturePolicy(
                key="security.crisis_interception",
                lifecycle=FeatureLifecycle.DISABLED,
                enabled=False,
            )
        }
    )

    result = service.evaluate("security.crisis_interception", context())

    assert result.enabled is True
    assert result.lifecycle is FeatureLifecycle.ACTIVE
    assert result.user_toggleable is False


def test_policy_validation_rejects_conflicting_target_lists_and_naive_timestamps() -> None:
    with pytest.raises(ValueError):
        FeaturePolicy(
            key="chat.standard_model",
            allow_user_hashes=["same"],
            deny_user_hashes=["same"],
        )

    with pytest.raises(ValueError):
        FeaturePolicy(
            key="chat.standard_model",
            starts_at_utc=datetime(2026, 8, 27, 12, 0),
        )


@pytest.mark.asyncio
async def test_policy_repository_round_trips_and_enforces_revision() -> None:
    from backend.core.config import Settings
    from backend.services.db_service import DBService, InMemoryDBProvider
    from backend.services.feature_policy_repository import (
        FeaturePolicyConflictError,
        FeaturePolicyRepository,
    )

    db = DBService(
        provider=InMemoryDBProvider(),
        settings=Settings(ENVIRONMENT="test", ENABLE_FIREBASE=False),
    )
    repository = FeaturePolicyRepository(db=db)
    policy = FeaturePolicy(
        key="chat.standard_model",
        enabled=True,
        starts_at_utc=NOW + timedelta(minutes=5),
    )

    written = await repository.upsert(policy, expected_revision=0)
    loaded = await repository.load()

    assert written.revision == 1
    assert loaded.revision == 1
    assert loaded.policies["chat.standard_model"].starts_at_utc == NOW + timedelta(minutes=5)

    with pytest.raises(FeaturePolicyConflictError):
        await repository.upsert(policy, expected_revision=0)


def test_public_feature_snapshot_is_safe_without_authentication() -> None:
    from fastapi.testclient import TestClient

    from backend.core.config import Settings
    from backend.main import create_app

    app = create_app(
        Settings(
            ENVIRONMENT="test",
            ENABLE_FIREBASE=False,
            ENABLE_OFFLINE_LLM_FALLBACK=True,
        )
    )

    with TestClient(app) as client:
        response = client.get("/api/features")
        admin_response = client.get("/api/admin/features")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    payload = response.json()
    assert payload["registry_version"] == 1
    assert any(item["key"] == "voice.live_v4" and item["enabled"] is False for item in payload["features"])
    assert admin_response.status_code in {401, 403}


def test_cyclic_prerequisites_fail_closed() -> None:
    from backend.models.feature_flags import FeatureSpec

    registry = {
        "feature.a": FeatureSpec(
            key="feature.a",
            title="A",
            description="A",
            prerequisites=("feature.b",),
        ),
        "feature.b": FeatureSpec(
            key="feature.b",
            title="B",
            description="B",
            prerequisites=("feature.a",),
        ),
    }

    result = FeatureFlagsService(registry=registry).evaluate("feature.a", context())

    assert result.enabled is False
    assert result.reason is FeatureReason.PREREQUISITE_DISABLED


def test_admin_target_ids_are_hashed_before_policy_persistence() -> None:
    from backend.api.feature_router import _policy_with_target_ids

    policy = FeaturePolicy(key="chat.standard_model", enabled=True)
    updated = _policy_with_target_ids(policy, ["firebase-user-123"], ["firebase-user-456"])

    assert updated.allow_user_hashes[0].startswith("usr_")
    assert updated.deny_user_hashes[0].startswith("usr_")
    assert "firebase-user-123" not in updated.allow_user_hashes
    assert "firebase-user-456" not in updated.deny_user_hashes


def test_verified_email_hash_allow_list_is_account_scoped() -> None:
    service = FeatureFlagsService(
        policies={
            "voice.live_v4": FeaturePolicy(
                key="voice.live_v4",
                lifecycle=FeatureLifecycle.ACTIVE,
                enabled=None,
                allow_admins=False,
                allow_user_hashes=["usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
            )
        }
    )

    allowed = service.evaluate(
        "voice.live_v4",
        context(email_hash="usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", is_admin=False),
    )
    denied = service.evaluate(
        "voice.live_v4",
        context(email_hash="usr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", is_admin=True),
    )

    assert allowed.enabled is True
    assert allowed.reason is FeatureReason.ENABLED
    assert denied.enabled is False
    assert denied.reason is FeatureReason.DISABLED


def test_verified_email_hash_deny_wins_over_allow() -> None:
    service = FeatureFlagsService(
        policies={
            "voice.live_v4": FeaturePolicy(
                key="voice.live_v4",
                lifecycle=FeatureLifecycle.ACTIVE,
                enabled=True,
                allow_user_hashes=["usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
                deny_user_hashes=["usr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
            )
        }
    )

    denied = service.evaluate(
        "voice.live_v4",
        context(email_hash="usr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    )

    assert denied.enabled is False
    assert denied.reason is FeatureReason.EXPLICIT_DENY
