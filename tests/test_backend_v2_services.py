from __future__ import annotations

import asyncio
import json
import time

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend.core.config import Settings
from backend.main import create_app
from backend.models.memory import MemoryCategory, MemoryGraph, make_memory_atom
from backend.services.db_service import DBService, InMemoryDBProvider
from backend.services.idempotency_service import IdempotencyConflictError, IdempotencyService
from backend.services.memory_repository import MemoryRepository, MemoryVersionConflictError
from backend.services.quota_service import QuotaExceededError, QuotaService
from backend.services.rate_limit_service import RateLimitService


def _db() -> DBService:
    return DBService(
        provider=InMemoryDBProvider(),
        settings=Settings(ENVIRONMENT="test", ENABLE_FIREBASE=False),
    )


@pytest.mark.asyncio
async def test_quota_reservation_is_atomic_and_idempotent() -> None:
    db = _db()
    quota = QuotaService(db=db, limit_5h=5, limit_week=5, reservation_ttl_seconds=60)

    async def reserve(index: int) -> bool:
        try:
            await quota.reserve(
                user_id_hash="quota-user",
                request_id=f"request-{index}",
                cost=1,
                operation="test",
            )
            return True
        except QuotaExceededError:
            return False

    outcomes = await asyncio.gather(*(reserve(index) for index in range(10)))
    assert sum(outcomes) == 5

    duplicate = await quota.reserve(
        user_id_hash="quota-user",
        request_id="request-0",
        cost=1,
        operation="test",
    )
    assert duplicate.duplicate is True
    assert duplicate.snapshot.credits_5h == 5


@pytest.mark.asyncio
async def test_quota_refund_and_stale_reservation_recovery() -> None:
    db = _db()
    quota = QuotaService(db=db, limit_5h=5, limit_week=5, reservation_ttl_seconds=60)
    await quota.reserve(user_id_hash="quota-user", request_id="retry", cost=2, operation="test")
    refunded = await quota.refund(user_id_hash="quota-user", request_id="retry")
    assert refunded.credits_5h == 0

    retried = await quota.reserve(user_id_hash="quota-user", request_id="retry", cost=2, operation="test")
    assert retried.duplicate is False
    account = await db.provider.get_document(QuotaService.COLLECTION, "quota-user")
    assert account is not None
    account["reservations"]["retry"]["created_at"] = time.time() - 120
    account["reservations"]["retry"]["updated_at"] = time.time() - 120
    await db.provider.set_document(QuotaService.COLLECTION, "quota-user", account)

    snapshot = await quota.get_snapshot(user_id_hash="quota-user")
    assert snapshot.credits_5h == 0
    assert snapshot.credits_week == 0


@pytest.mark.asyncio
async def test_distributed_rate_limit_is_atomic() -> None:
    limiter = RateLimitService(db=_db())

    async def consume() -> bool:
        try:
            await limiter.consume(scope="chat", subject="user", limit=3, window_seconds=60)
            return True
        except Exception:
            return False

    outcomes = await asyncio.gather(*(consume() for _ in range(8)))
    assert sum(outcomes) == 3


@pytest.mark.asyncio
async def test_idempotency_replays_and_rejects_payload_reuse() -> None:
    service = IdempotencyService(db=_db(), ttl_seconds=300, processing_timeout_seconds=30)
    claim = await service.claim(
        user_id_hash="user",
        key="request-key",
        operation="chat",
        payload_hash="payload-a",
    )
    assert claim.owner is True
    await service.complete(claim=claim, response={"answer": "done"})

    replay = await service.claim(
        user_id_hash="user",
        key="request-key",
        operation="chat",
        payload_hash="payload-a",
    )
    assert replay.completed is True
    assert replay.response == {"answer": "done"}

    with pytest.raises(IdempotencyConflictError):
        await service.claim(
            user_id_hash="user",
            key="request-key",
            operation="chat",
            payload_hash="payload-b",
        )


@pytest.mark.asyncio
async def test_memory_merges_concurrently_without_lost_updates() -> None:
    repository = MemoryRepository(db=_db())
    user = "memory-user"
    first = make_memory_atom(user_id_hash=user, category=MemoryCategory.PROJECTS, value="MindPal")
    second = make_memory_atom(user_id_hash=user, category=MemoryCategory.GOALS, value="Ship production release")

    await asyncio.gather(
        repository.merge(user_id_hash=user, delta=[first]),
        repository.merge(user_id_hash=user, delta=[second]),
    )

    graph = await repository.load(user)
    assert {atom.id for atom in graph.active_atoms} == {first.id, second.id}
    assert graph.version == 3


@pytest.mark.asyncio
async def test_memory_replace_rejects_stale_device_and_noop_does_not_bump_version() -> None:
    repository = MemoryRepository(db=_db())
    user = "memory-user"
    initial = await repository.load(user)
    atom = make_memory_atom(user_id_hash=user, category=MemoryCategory.PREFERENCES, value="Direct answers")
    written = await repository.replace(
        user_id_hash=user,
        graph=MemoryGraph(user_id_hash=user, atoms=[atom]),
        expected_version=initial.version,
    )
    same = await repository.replace(
        user_id_hash=user,
        graph=written.snapshot,
        expected_version=written.snapshot.version,
    )
    assert same.changed is False
    assert same.snapshot.version == written.snapshot.version

    with pytest.raises(MemoryVersionConflictError):
        await repository.replace(
            user_id_hash=user,
            graph=initial,
            expected_version=initial.version,
        )


def test_production_configuration_rejects_unsafe_docs_and_fail_closes_auth() -> None:
    safe = {
        "ENVIRONMENT": "production",
        "CORS_ORIGINS": ["https://mindpal.example"],
        "TRUSTED_HOSTS": ["mindpal.example"],
        "ENABLE_HSTS": True,
        "ENABLE_FIREBASE": True,
        "FIREBASE_CREDENTIALS_JSON": '{"type":"service_account"}',
        "FIREBASE_CHECK_REVOKED_TOKENS": True,
        "FIREBASE_PROJECT_ID": "mindpal-production",
        "FIREBASE_WEB_API_KEY": "public-web-key",
        "FIREBASE_AUTH_DOMAIN": "mindpal-production.firebaseapp.com",
        "FIREBASE_WEB_PROJECT_ID": "mindpal-production",
        "FIREBASE_WEB_APP_ID": "1:123:web:mindpal",
        "REQUIRE_FIREBASE_APP_CHECK": True,
        "FIREBASE_APPCHECK_SITE_KEY": "public-recaptcha-enterprise-site-key",
        "GEMINI_API_KEY": "provider-key",
        "REQUIRE_REMOTE_LLM_PROVIDER": True,
        "ENABLE_OFFLINE_LLM_FALLBACK": False,
        "ALLOW_OFFLINE_LLM_IN_PRODUCTION": False,
    }
    settings = Settings(**safe, ALLOW_ANONYMOUS_SESSIONS=True)
    assert settings.ALLOW_ANONYMOUS_SESSIONS is False
    with pytest.raises(ValidationError):
        Settings(**safe, ENABLE_DOCS=True)


def test_production_configuration_disables_firebase_when_credentials_missing() -> None:
    settings = Settings(
        ENVIRONMENT="production",
        CORS_ORIGINS=["https://mindpal.example"],
        TRUSTED_HOSTS=["mindpal.example"],
        ENABLE_HSTS=True,
        ENABLE_FIREBASE=False,
        FIREBASE_CHECK_REVOKED_TOKENS=True,
        FIREBASE_PROJECT_ID="mindpal-production",
        FIREBASE_WEB_API_KEY="public-web-key",
        FIREBASE_AUTH_DOMAIN="mindpal-production.firebaseapp.com",
        FIREBASE_WEB_PROJECT_ID="mindpal-production",
        FIREBASE_WEB_APP_ID="1:123:web:mindpal",
        REQUIRE_FIREBASE_APP_CHECK=True,
        FIREBASE_APPCHECK_SITE_KEY="public-recaptcha-enterprise-site-key",
        GEMINI_API_KEY="provider-key",
        REQUIRE_REMOTE_LLM_PROVIDER=True,
        ENABLE_OFFLINE_LLM_FALLBACK=False,
        ALLOW_OFFLINE_LLM_IN_PRODUCTION=False,
    )
    assert settings.ENABLE_FIREBASE is False


def test_production_configuration_enables_revoked_token_checks_when_disabled() -> None:
    settings = Settings(
        ENVIRONMENT="production",
        CORS_ORIGINS=["https://mindpal.example"],
        TRUSTED_HOSTS=["mindpal.example"],
        ENABLE_HSTS=True,
        ENABLE_FIREBASE=False,
        FIREBASE_CHECK_REVOKED_TOKENS=False,
        FIREBASE_PROJECT_ID="mindpal-production",
        FIREBASE_WEB_API_KEY="public-web-key",
        FIREBASE_AUTH_DOMAIN="mindpal-production.firebaseapp.com",
        FIREBASE_WEB_PROJECT_ID="mindpal-production",
        FIREBASE_WEB_APP_ID="1:123:web:mindpal",
        REQUIRE_FIREBASE_APP_CHECK=False,
        FIREBASE_APPCHECK_SITE_KEY="public-recaptcha-enterprise-site-key",
        GEMINI_API_KEY="provider-key",
        REQUIRE_REMOTE_LLM_PROVIDER=True,
        ENABLE_OFFLINE_LLM_FALLBACK=False,
        ALLOW_OFFLINE_LLM_IN_PRODUCTION=False,
    )
    assert settings.FIREBASE_CHECK_REVOKED_TOKENS is True
    assert settings.REQUIRE_FIREBASE_APP_CHECK is True


def test_request_body_limit_rejects_before_route_parsing() -> None:
    settings = Settings(
        ENVIRONMENT="test",
        MAX_REQUEST_BODY_BYTES=1024,
        ENABLE_FIREBASE=False,
    )
    app = create_app(settings)
    with TestClient(app) as client:
        response = client.post(
            "/api/chat",
            content=b"x" * 2048,
            headers={"content-type": "application/json"},
        )
    assert response.status_code == 413
    assert response.json()["code"] == "request_body_too_large"
    assert response.json()["request_id"] == response.headers["X-Request-ID"]

@pytest.mark.asyncio
async def test_chat_sync_is_transactional_and_sanitizes_voice_metadata() -> None:
    from types import SimpleNamespace

    from backend.api.chat_store_router import ChatAppendPayload, append_current_chat_messages
    from backend.services.idempotency_service import IdempotencyService

    db = _db()
    services = SimpleNamespace(
        db=db,
        idempotency=IdempotencyService(db=db),
        rate_limits=RateLimitService(db=db),
        settings=SimpleNamespace(CHAT_SYNC_RATE_LIMIT_PER_MINUTE=100),
    )

    def context(request_id: str) -> SimpleNamespace:
        return SimpleNamespace(
            request_id=request_id,
            session=SimpleNamespace(authenticated=True, user_id_hash="chat-user"),
        )

    voice = {
        "messageId": "voice-1",
        "role": "MindPal",
        "text": "[Voice Call]",
        "createdAt": "2026-07-10T10:00:00Z",
        "type": "voice_call",
        "voiceCall": {
            "startTime": "2026-07-10T10:00:00Z",
            "durationMs": 1_000,
            "durationStr": "00:01",
            "userTranscript": "hello",
            "aiTranscript": "hi",
            "summary": "test call",
            "providerSecret": "must-not-persist",
            "nested": {"arbitrary": "object"},
        },
    }
    normal = {
        "messageId": "text-1",
        "role": "User",
        "text": "second message",
        "createdAt": "2026-07-10T10:00:01Z",
    }

    await asyncio.gather(
        append_current_chat_messages(
            payload=ChatAppendPayload(messages=[voice]),
            services=services,
            context=context("sync-1"),
        ),
        append_current_chat_messages(
            payload=ChatAppendPayload(messages=[normal]),
            services=services,
            context=context("sync-2"),
        ),
    )

    document = await db.provider.get_document("chat_sessions", "chat-user__current")
    assert document is not None
    assert document["message_count"] == 2
    stored_voice = next(item for item in document["messages"] if item["message_id"] == "voice-1")
    assert set(stored_voice["voiceCall"]) == {
        "startTime", "endTime", "durationMs", "durationStr",
        "userTranscript", "aiTranscript", "summary",
    }
    assert "providerSecret" not in stored_voice["voiceCall"]


@pytest.mark.asyncio
async def test_profile_partial_updates_do_not_lose_concurrent_fields() -> None:
    from backend.models.user import UserProfileUpdate

    db = _db()
    await asyncio.gather(
        db.update_user_profile("profile-user", UserProfileUpdate(notes="persistent note")),
        db.update_user_profile("profile-user", UserProfileUpdate(metadata={"theme": "dark"})),
    )
    loaded = await db.load_user_profile("profile-user")
    assert loaded.profile.notes == "persistent note"
    assert loaded.profile.metadata == {"theme": "dark"}


def test_valid_production_configuration_is_fail_closed_and_explicit() -> None:
    settings = Settings(
        ENVIRONMENT="production",
        CORS_ORIGINS=["https://mindpal.example"],
        TRUSTED_HOSTS=["mindpal.example"],
        ENABLE_HSTS=True,
        ENABLE_DOCS=False,
        ENABLE_FIREBASE=True,
        FIREBASE_CREDENTIALS_JSON='{"type":"service_account"}',
        FIREBASE_CHECK_REVOKED_TOKENS=True,
        FIREBASE_PROJECT_ID="mindpal-production",
        FIREBASE_WEB_API_KEY="public-web-key",
        FIREBASE_AUTH_DOMAIN="mindpal-production.firebaseapp.com",
        FIREBASE_WEB_PROJECT_ID="mindpal-production",
        FIREBASE_WEB_APP_ID="1:123:web:mindpal",
        REQUIRE_FIREBASE_APP_CHECK=True,
        FIREBASE_APPCHECK_SITE_KEY="public-recaptcha-enterprise-site-key",
        GEMINI_API_KEY="provider-key",
        REQUIRE_REMOTE_LLM_PROVIDER=True,
        ENABLE_OFFLINE_LLM_FALLBACK=False,
        ALLOW_OFFLINE_LLM_IN_PRODUCTION=False,
    )
    assert settings.is_production is True
    assert settings.ALLOW_ANONYMOUS_SESSIONS is False


def test_request_id_is_stable_across_body_headers_and_logs_boundary() -> None:
    settings = Settings(ENVIRONMENT="test", ENABLE_FIREBASE=False)
    app = create_app(settings)
    with TestClient(app) as client:
        generated = client.get("/api/health")
        supplied = client.get("/api/health", headers={"X-Request-ID": "client-request-123"})

    assert generated.status_code == 200
    assert generated.json()["request_id"] == generated.headers["X-Request-ID"]
    assert generated.headers["Cache-Control"] == "no-store"
    assert supplied.json()["request_id"] == "client-request-123"
    assert supplied.headers["X-Request-ID"] == "client-request-123"
    assert app.title == "MindPal"
    assert app.version == "2.0.0"


def test_rate_limit_errors_emit_retry_after_header() -> None:
    from backend.core.errors import RateLimitError

    app = create_app(Settings(ENVIRONMENT="test", ENABLE_FIREBASE=False))

    @app.get("/test-rate-limit")
    async def fail_with_rate_limit() -> None:
        raise RateLimitError("Too many requests", details={"retry_after_seconds": 7})

    with TestClient(app) as client:
        response = client.get("/test-rate-limit")

    assert response.status_code == 429
    assert response.headers["Retry-After"] == "7"
    assert response.json()["code"] == "rate_limit_exceeded"


def test_chat_history_is_compacted_below_firestore_document_limit() -> None:
    from backend.api.chat_store_router import MAX_CHAT_DOCUMENT_BYTES, _bound_messages

    messages = [
        {
            "message_id": f"message-{index}",
            "role": "User",
            "text": f"{index}:" + ("x" * 23_900),
            "created_at": f"2026-07-10T10:{index % 60:02d}:00Z",
        }
        for index in range(100)
    ]
    bounded = _bound_messages(messages)
    encoded = json.dumps({"messages": bounded}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    assert len(encoded) <= MAX_CHAT_DOCUMENT_BYTES
    assert bounded
    assert bounded[-1]["message_id"] == "message-99"
    assert len(bounded) < len(messages)


def test_memory_graph_is_compacted_below_firestore_document_limit_and_keeps_pinned_identity() -> None:
    from backend.services.memory_repository import MAX_MEMORY_DOCUMENT_BYTES, _fit_graph_document

    user = "large-memory-user"
    pinned = make_memory_atom(
        user_id_hash=user,
        category=MemoryCategory.PROFILE,
        value="Preferred name is Marwan",
        pinned=True,
        confidence=1.0,
        metadata={"field": "preferred_name"},
    )
    atoms = [pinned]
    for index in range(499):
        atoms.append(
            make_memory_atom(
                user_id_hash=user,
                category=MemoryCategory.FACTS,
                value=f"fact-{index}-" + ("v" * 650),
                confidence=0.1,
                metadata={"context": "m" * 650},
            )
        )

    fitted = _fit_graph_document(MemoryGraph(user_id_hash=user, atoms=atoms))
    encoded = json.dumps(fitted.model_dump(mode="json"), ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    assert len(encoded) <= MAX_MEMORY_DOCUMENT_BYTES
    assert any(atom.id == pinned.id for atom in fitted.atoms)
    assert len(fitted.atoms) < len(atoms)


@pytest.mark.asyncio
async def test_oversized_idempotency_response_is_not_persisted_for_replay() -> None:
    service = IdempotencyService(db=_db(), ttl_seconds=300, processing_timeout_seconds=30)
    claim = await service.claim(
        user_id_hash="user",
        key="large-response",
        operation="chat",
        payload_hash="payload-a",
    )
    await service.complete(claim=claim, response={"answer": "x" * (service.MAX_REPLAY_RESPONSE_BYTES + 1)})

    with pytest.raises(IdempotencyConflictError):
        await service.claim(
            user_id_hash="user",
            key="large-response",
            operation="chat",
            payload_hash="payload-a",
        )


def test_trusted_hosts_and_cors_accept_comma_separated_env_style_values() -> None:
    settings = Settings(
        ENVIRONMENT="test",
        ENABLE_FIREBASE=False,
        CORS_ORIGINS="https://a.example, https://b.example",
        TRUSTED_HOSTS="a.example,b.example",
    )
    assert settings.CORS_ORIGINS == ["https://a.example", "https://b.example"]
    assert settings.TRUSTED_HOSTS == ["a.example", "b.example"]




def test_admin_boundary_requires_explicit_verified_custom_claim() -> None:
    from types import SimpleNamespace
    from fastapi import HTTPException
    from backend.api.dependencies import assert_admin

    normal = SimpleNamespace(
        request_id="request",
        session=SimpleNamespace(authenticated=True, metadata={"admin": False}),
    )
    admin = SimpleNamespace(
        request_id="request",
        session=SimpleNamespace(authenticated=True, metadata={"admin": True}),
    )

    with pytest.raises(HTTPException) as exc_info:
        assert_admin(normal)
    assert exc_info.value.status_code == 403
    assert_admin(admin)


def test_app_factory_owns_services_built_from_its_explicit_settings() -> None:
    settings = Settings(
        ENVIRONMENT="test",
        ENABLE_FIREBASE=False,
        ALLOW_ANONYMOUS_SESSIONS=True,
        ENABLE_OFFLINE_LLM_FALLBACK=True,
        REQUIRE_REMOTE_LLM_PROVIDER=False,
        QUOTA_LIMIT_5H=7,
        QUOTA_LIMIT_WEEK=11,
    )
    app = create_app(settings)
    with TestClient(app) as client:
        response = client.get("/api/health/ready")
        assert response.status_code in {200, 503}
        container = app.state.service_container
        assert container is not None
        assert container.settings is settings
        assert container.quota.limit_5h == 7
        assert container.quota.limit_week == 11
    assert app.state.service_container is None


def test_production_configuration_requires_firebase_app_check() -> None:
    base = {
        "ENVIRONMENT": "production",
        "CORS_ORIGINS": ["https://mindpal.example"],
        "TRUSTED_HOSTS": ["mindpal.example"],
        "ENABLE_HSTS": True,
        "ENABLE_DOCS": False,
        "ENABLE_FIREBASE": True,
        "FIREBASE_CREDENTIALS_JSON": '{"type":"service_account"}',
        "FIREBASE_CHECK_REVOKED_TOKENS": True,
        "FIREBASE_PROJECT_ID": "mindpal-production",
        "FIREBASE_WEB_API_KEY": "public-web-key",
        "FIREBASE_AUTH_DOMAIN": "mindpal-production.firebaseapp.com",
        "FIREBASE_WEB_PROJECT_ID": "mindpal-production",
        "FIREBASE_WEB_APP_ID": "1:123:web:mindpal",
        "GEMINI_API_KEY": "provider-key",
        "REQUIRE_REMOTE_LLM_PROVIDER": True,
        "ENABLE_OFFLINE_LLM_FALLBACK": False,
        "ALLOW_OFFLINE_LLM_IN_PRODUCTION": False,
    }
    with pytest.raises(ValidationError):
        Settings(**base, REQUIRE_FIREBASE_APP_CHECK=False)
    with pytest.raises(ValidationError):
        Settings(**base, REQUIRE_FIREBASE_APP_CHECK=True, FIREBASE_APPCHECK_SITE_KEY="")


@pytest.mark.asyncio
async def test_app_check_verification_requires_verified_app_identity() -> None:
    from backend.core.errors import AuthError
    from backend.services.auth_service import AuthIdentity, AuthService

    class FakeProvider:
        name = "fake"
        is_configured = True

        async def verify_bearer_token(self, token: str) -> AuthIdentity:
            return AuthIdentity(raw_user_id="user", provider=self.name)

        async def verify_app_check_token(self, token: str) -> dict[str, str]:
            if token == "valid-app-check":
                return {"app_id": "1:123:web:mindpal"}
            if token == "missing-identity":
                return {}
            raise AuthError("rejected", code="app_check_rejected")

    service = AuthService(
        provider=FakeProvider(),
        settings=Settings(ENVIRONMENT="test", ENABLE_FIREBASE=False),
        allow_anonymous=False,
    )
    assert await service.verify_app_check_token("valid-app-check") == {"app_id": "1:123:web:mindpal"}
    with pytest.raises(AuthError) as missing:
        await service.verify_app_check_token(None)
    assert missing.value.code == "app_check_missing"
    with pytest.raises(AuthError) as malformed:
        await service.verify_app_check_token("missing-identity")
    assert malformed.value.code == "app_check_identity_missing"


def test_openapi_generation_resolves_all_route_dependencies() -> None:
    app = create_app(Settings(ENVIRONMENT="test", ENABLE_FIREBASE=False))
    schema = app.openapi()
    paths = schema.get("paths", {})
    assert "/api/chat" in paths
    assert "/api/chat/stream" in paths
    assert "/api/tools/list" in paths
    assert "/api/voice/token" in paths
    assert "/api/memory/v3" in paths
