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
    Full public health check.

    This endpoint must not expose:
    - API keys
    - auth tokens
    - Firebase credentials
    - raw prompts
    - raw user messages
    - memory contents
    - profile contents
    """
    service_health = await services.health()

    dependencies = _build_dependency_health(service_health)
    state = _overall_state(dependencies)

    return HealthResponse(
        status=state,
        project_name="MindPal",
        version=_safe_setting(services.settings, "APP_VERSION", "1.0.0"),
        environment=_safe_setting(services.settings, "ENVIRONMENT", "development"),
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

    In local/mock/offline mode, the app can still be ready because the safety
    shell, offline LLM fallback, mock DB, and browser TTS fallback are valid
    development/demo fallbacks.
    """
    service_health = await services.health()
    dependencies = _build_dependency_health(service_health)

    critical_names = {
        "auth",
        "db",
        "llm",
        "memory",
        "output_guard",
        "rag",
        "safety",
        "tts",
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
        environment=_safe_setting(services.settings, "ENVIRONMENT", "development"),
        dependencies=dependencies,
    )


def _build_dependency_health(service_health: dict[str, object]) -> list[DependencyHealth]:
    dependencies: list[DependencyHealth] = []

    auth = _as_dict(service_health.get("auth"))
    dependencies.append(
        DependencyHealth(
            name="auth",
            state=HealthState.OK,
            enabled=True,
            detail=(
                "provider_configured="
                f"{bool(auth.get('provider_configured', False))}; "
                "anonymous_allowed="
                f"{bool(auth.get('allow_anonymous', False))}"
            ),
        )
    )

    db = _as_dict(service_health.get("db"))
    dependencies.append(
        DependencyHealth(
            name="db",
            state=HealthState.OK,
            enabled=True,
            detail=(
                f"provider={_safe_value(db.get('provider'), 'unknown')}; "
                f"mock_mode={bool(db.get('mock_mode', False))}"
            ),
        )
    )

    llm = _as_dict(service_health.get("llm"))
    llm_providers = llm.get("providers", [])
    llm_has_configured = _any_configured_provider(llm_providers)
    llm_offline_available = bool(llm.get("offline_available", False))
    dependencies.append(
        DependencyHealth(
            name="llm",
            state=HealthState.OK if llm_has_configured or llm_offline_available else HealthState.ERROR,
            enabled=True,
            detail=(
                f"configured_provider_available={llm_has_configured}; "
                f"offline_available={llm_offline_available}"
            ),
        )
    )

    memory = _as_dict(service_health.get("memory"))
    dependencies.append(
        DependencyHealth(
            name="memory",
            state=HealthState.OK if bool(memory.get("local_fallback_available", True)) else HealthState.DEGRADED,
            enabled=True,
            detail=(
                f"llm_primary_enabled={bool(memory.get('llm_primary_enabled', False))}; "
                f"local_fallback_available={bool(memory.get('local_fallback_available', False))}"
            ),
        )
    )

    output_guard = _as_dict(service_health.get("output_guard"))
    dependencies.append(
        DependencyHealth(
            name="output_guard",
            state=HealthState.OK if int(output_guard.get("rules_loaded", 0) or 0) > 0 else HealthState.ERROR,
            enabled=True,
            detail=(
                f"rules_loaded={int(output_guard.get('rules_loaded', 0) or 0)}; "
                f"llm_rewrite_enabled={bool(output_guard.get('llm_rewrite_enabled', False))}"
            ),
        )
    )

    rag = _as_dict(service_health.get("rag"))
    dependencies.append(
        DependencyHealth(
            name="rag",
            state=HealthState.OK if int(rag.get("units_loaded", 0) or 0) > 0 else HealthState.DEGRADED,
            enabled=True,
            detail=(
                f"units_loaded={int(rag.get('units_loaded', 0) or 0)}; "
                f"vector_db_required={bool(rag.get('vector_db_required', False))}"
            ),
        )
    )

    safety = _as_dict(service_health.get("safety"))
    safety_ok = (
        int(safety.get("rules_loaded", 0) or 0) > 0
        and int(safety.get("templates_loaded", 0) or 0) > 0
        and bool(safety.get("imminent_self_harm_bypasses_llm", False))
    )
    dependencies.append(
        DependencyHealth(
            name="safety",
            state=HealthState.OK if safety_ok else HealthState.ERROR,
            enabled=True,
            detail=(
                f"rules_loaded={int(safety.get('rules_loaded', 0) or 0)}; "
                f"templates_loaded={int(safety.get('templates_loaded', 0) or 0)}; "
                f"crisis_bypass={bool(safety.get('imminent_self_harm_bypasses_llm', False))}"
            ),
        )
    )

    tts = _as_dict(service_health.get("tts"))
    dependencies.append(
        DependencyHealth(
            name="tts",
            state=HealthState.OK if bool(tts.get("browser_fallback_available", False)) else HealthState.DEGRADED,
            enabled=True,
            detail=(
                f"browser_fallback_available={bool(tts.get('browser_fallback_available', False))}; "
                f"external_crisis_disabled={bool(tts.get('external_tts_disabled_by_default_for_crisis', False))}"
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
    return sanitize_text(str(value or default), 80) or default


def _safe_value(value: object, default: str) -> str:
    cleaned = sanitize_text(str(value or default), 120)
    return cleaned or default