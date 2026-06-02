# backend/api/health_router.py

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from backend.api.dependencies import RequestIdDep, ServicesDep
from backend.core.security import sanitize_text
from backend.models.schemas import DependencyHealth, HealthResponse, HealthState


router = APIRouter(prefix="/api", tags=["health"])


@router.get("/health", response_model=HealthResponse)
async def health(
    services: ServicesDep,
) -> HealthResponse:
    """
    Public health check.

    This endpoint must not expose:
    - API keys
    - auth tokens
    - Firebase credentials
    - raw prompts
    - raw user messages
    - memory contents
    - profile contents

    In production, this endpoint must not report OK when critical production
    dependencies silently fell back to mock/authless/offline-only behavior.
    """
    service_health = await services.health()
    environment = _safe_setting(services.settings, "ENVIRONMENT", "development")
    production = _is_production(environment)

    dependencies = _build_dependency_health(service_health, production=production)
    state = _overall_state(dependencies)

    return HealthResponse(
        status=state,
        project_name="MindPal",
        version=_safe_setting(services.settings, "APP_VERSION", "1.0.0"),
        environment=environment,
        dependencies=dependencies,
    )


@router.get("/health/live")
async def liveness(
    request_id: RequestIdDep,
) -> dict[str, str]:
    """
    Minimal liveness check.

    Should stay lightweight and avoid touching providers or storage.
    """
    return {
        "status": HealthState.OK.value,
        "request_id": request_id,
    }


@router.get("/health/ready", response_model=HealthResponse)
async def readiness(
    services: ServicesDep,
) -> HealthResponse:
    """
    Readiness check.

    Production readiness is strict:
    - Firebase auth provider must be configured.
    - Firestore must not be in mock mode.
    - At least one remote LLM provider should be configured.
    - Safety/output guard/RAG must have loaded rules/corpus.

    Development can tolerate some fallback paths, but production cannot silently
    rely on mock DB or missing auth provider.
    """
    service_health = await services.health()
    environment = _safe_setting(services.settings, "ENVIRONMENT", "development")
    production = _is_production(environment)

    dependencies = _build_dependency_health(service_health, production=production)

    critical_names = {
        "auth",
        "db",
        "llm",
        "memory",
        "output_guard",
        "rag",
        "safety",
    }

    critical_dependencies = [
        dependency
        for dependency in dependencies
        if dependency.name in critical_names
    ]

    state = _overall_state(critical_dependencies)

    return HealthResponse(
        status=state,
        project_name="MindPal",
        version=_safe_setting(services.settings, "APP_VERSION", "1.0.0"),
        environment=environment,
        dependencies=dependencies,
    )


def _build_dependency_health(
    service_health: dict[str, object],
    *,
    production: bool,
) -> list[DependencyHealth]:
    dependencies: list[DependencyHealth] = []

    auth = _as_dict(service_health.get("auth"))
    auth_provider_configured = bool(auth.get("provider_configured", False))
    auth_allow_anonymous = bool(auth.get("allow_anonymous", False))
    auth_trusts_unverified = bool(auth.get("trusts_unverified_bearer_tokens", False))
    invalid_bearer_fallback = bool(auth.get("invalid_bearer_falls_back_to_anonymous", False))
    auth_init_error = _safe_optional(auth.get("provider_init_error"))

    if auth_trusts_unverified or invalid_bearer_fallback:
        auth_state = HealthState.ERROR
    elif production and not auth_provider_configured:
        auth_state = HealthState.ERROR
    elif not auth_provider_configured:
        auth_state = HealthState.DEGRADED
    else:
        auth_state = HealthState.OK

    dependencies.append(
        DependencyHealth(
            name="auth",
            state=auth_state,
            enabled=True,
            detail=(
                f"provider={_safe_value(auth.get('provider'), 'unknown')}; "
                f"provider_configured={auth_provider_configured}; "
                f"anonymous_allowed={auth_allow_anonymous}; "
                f"trusts_unverified_bearer_tokens={auth_trusts_unverified}; "
                f"invalid_bearer_falls_back_to_anonymous={invalid_bearer_fallback}"
                + (f"; init_error={auth_init_error}" if auth_init_error else "")
            ),
        )
    )

    db = _as_dict(service_health.get("db"))
    db_provider = _safe_value(db.get("provider"), "unknown")
    db_mock_mode = bool(db.get("mock_mode", False))
    db_provider_configured = bool(db.get("provider_configured", False))
    db_database_id = _safe_optional(db.get("database_id"))
    db_project_id = _safe_optional(db.get("project_id"))
    db_init_error = _safe_optional(db.get("firebase_init_error"))

    if production and db_mock_mode:
        db_state = HealthState.ERROR
    elif db_provider == "firebase" and db_provider_configured and not db_mock_mode:
        db_state = HealthState.OK
    elif db_mock_mode:
        db_state = HealthState.DEGRADED
    else:
        db_state = HealthState.ERROR

    dependencies.append(
        DependencyHealth(
            name="db",
            state=db_state,
            enabled=True,
            detail=(
                f"provider={db_provider}; "
                f"provider_configured={db_provider_configured}; "
                f"mock_mode={db_mock_mode}; "
                f"project_id={db_project_id or 'unknown'}; "
                f"database_id={db_database_id or 'unknown'}"
                + (f"; init_error={db_init_error}" if db_init_error else "")
            ),
        )
    )

    llm = _as_dict(service_health.get("llm"))
    llm_providers = llm.get("providers", [])
    llm_has_configured = _any_configured_provider(llm_providers)
    llm_offline_available = bool(llm.get("offline_available", False))

    if llm_has_configured:
        llm_state = HealthState.OK
    elif production:
        llm_state = HealthState.ERROR
    elif llm_offline_available:
        llm_state = HealthState.DEGRADED
    else:
        llm_state = HealthState.ERROR

    dependencies.append(
        DependencyHealth(
            name="llm",
            state=llm_state,
            enabled=True,
            detail=(
                f"configured_provider_available={llm_has_configured}; "
                f"offline_available={llm_offline_available}"
            ),
        )
    )

    memory = _as_dict(service_health.get("memory"))
    memory_llm_primary = bool(memory.get("llm_primary_enabled", False))
    memory_local_fallback = bool(memory.get("local_fallback_available", False))

    if memory_llm_primary:
        memory_state = HealthState.OK
    elif production:
        memory_state = HealthState.DEGRADED if memory_local_fallback else HealthState.ERROR
    else:
        memory_state = HealthState.OK if memory_local_fallback else HealthState.DEGRADED

    dependencies.append(
        DependencyHealth(
            name="memory",
            state=memory_state,
            enabled=True,
            detail=(
                f"llm_primary_enabled={memory_llm_primary}; "
                f"local_fallback_available={memory_local_fallback}"
            ),
        )
    )

    output_guard = _as_dict(service_health.get("output_guard"))
    output_guard_rules = int(output_guard.get("rules_loaded", 0) or 0)
    output_guard_rewrite = bool(output_guard.get("llm_rewrite_enabled", False))

    dependencies.append(
        DependencyHealth(
            name="output_guard",
            state=HealthState.OK if output_guard_rules > 0 else HealthState.ERROR,
            enabled=True,
            detail=(
                f"rules_loaded={output_guard_rules}; "
                f"llm_rewrite_enabled={output_guard_rewrite}"
            ),
        )
    )

    rag = _as_dict(service_health.get("rag"))
    rag_units = int(rag.get("units_loaded", 0) or 0)
    rag_vector_required = bool(rag.get("vector_db_required", False))
    rag_builtin_fallback = bool(rag.get("using_builtin_fallback", False))

    if rag_units > 0 and not (production and rag_builtin_fallback):
        rag_state = HealthState.OK
    elif rag_units > 0:
        rag_state = HealthState.DEGRADED
    else:
        rag_state = HealthState.ERROR if production else HealthState.DEGRADED

    dependencies.append(
        DependencyHealth(
            name="rag",
            state=rag_state,
            enabled=True,
            detail=(
                f"units_loaded={rag_units}; "
                f"vector_db_required={rag_vector_required}; "
                f"using_builtin_fallback={rag_builtin_fallback}"
            ),
        )
    )

    safety = _as_dict(service_health.get("safety"))
    safety_rules = int(safety.get("rules_loaded", 0) or 0)
    safety_templates = int(safety.get("templates_loaded", 0) or 0)
    safety_crisis_bypass = bool(safety.get("imminent_self_harm_bypasses_llm", False))

    safety_ok = safety_rules > 0 and safety_templates > 0 and safety_crisis_bypass

    dependencies.append(
        DependencyHealth(
            name="safety",
            state=HealthState.OK if safety_ok else HealthState.ERROR,
            enabled=True,
            detail=(
                f"rules_loaded={safety_rules}; "
                f"templates_loaded={safety_templates}; "
                f"crisis_bypass={safety_crisis_bypass}"
            ),
        )
    )

    tts = _as_dict(service_health.get("tts"))
    tts_browser_fallback = bool(tts.get("browser_fallback_available", False))
    tts_external_crisis_disabled = bool(
        tts.get("external_tts_disabled_by_default_for_crisis", False)
    )
    tts_has_configured = _any_configured_provider(tts.get("providers", []))

    if tts_has_configured:
        tts_state = HealthState.OK
    elif tts_browser_fallback:
        tts_state = HealthState.DEGRADED if production else HealthState.OK
    else:
        tts_state = HealthState.DEGRADED

    dependencies.append(
        DependencyHealth(
            name="tts",
            state=tts_state,
            enabled=True,
            detail=(
                f"configured_provider_available={tts_has_configured}; "
                f"browser_fallback_available={tts_browser_fallback}; "
                f"external_crisis_disabled={tts_external_crisis_disabled}"
            ),
        )
    )

    return dependencies


def _overall_state(dependencies: list[DependencyHealth]) -> HealthState:
    if any(dependency.state == HealthState.ERROR for dependency in dependencies):
        return HealthState.ERROR

    if any(dependency.state == HealthState.DEGRADED for dependency in dependencies):
        return HealthState.DEGRADED

    return HealthState.OK


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _any_configured_provider(value: object) -> bool:
    if not isinstance(value, list):
        return False

    for item in value:
        if isinstance(item, dict) and bool(item.get("configured", False)):
            return True

    return False


def _safe_setting(settings: object, name: str, default: str) -> str:
    value = getattr(settings, name, default)

    if hasattr(value, "get_secret_value"):
        value = value.get_secret_value()

    return sanitize_text(str(value or default), 80) or default


def _safe_value(value: object, default: str) -> str:
    cleaned = sanitize_text(str(value or default), 120)
    return cleaned or default


def _safe_optional(value: object) -> str | None:
    if value is None:
        return None

    cleaned = sanitize_text(str(value), 220)
    return cleaned or None


def _is_production(environment: str) -> bool:
    return sanitize_text(environment, 80).lower() in {"production", "prod"}