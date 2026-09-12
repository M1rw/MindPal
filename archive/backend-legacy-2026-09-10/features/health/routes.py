# backend/features/health/routes.py

"""
Health, readiness, and diagnostics HTTP endpoints.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, status
from fastapi.responses import JSONResponse

from backend.api.dependencies import AdminRequestContextDep, RequestIdDep, ServicesDep
from backend.core.security import sanitize_text
from backend.models.schemas import DependencyHealth, HealthResponse, HealthState

router = APIRouter(prefix="/api", tags=["health"])


@router.get("/health")
async def health(request_id: RequestIdDep) -> dict[str, str]:
    """Public minimal health surface; no infrastructure fingerprinting."""
    return {"status": HealthState.OK.value, "request_id": request_id}


@router.get("/health/live")
async def liveness(request_id: RequestIdDep) -> dict[str, str]:
    return {"status": HealthState.OK.value, "request_id": request_id}


@router.get("/health/ready")
async def readiness(
    services: ServicesDep,
    request_id: RequestIdDep,
) -> JSONResponse:
    """Minimal readiness result suitable for deployment probes."""
    service_health = await services.health()
    environment = _safe_setting(services.settings, "ENVIRONMENT", "development")
    dependencies = _build_dependency_health(service_health, production=_is_production(environment))
    critical = [item for item in dependencies if item.name in {"auth", "db", "llm", "memory", "output_guard", "rag", "safety"}]
    state = _overall_state(critical)
    code = status.HTTP_200_OK if state != HealthState.ERROR else status.HTTP_503_SERVICE_UNAVAILABLE
    return JSONResponse(status_code=code, content={"status": state.value, "request_id": request_id})


@router.get("/health/diagnostics", response_model=HealthResponse)
async def diagnostics(
    services: ServicesDep,
    context: AdminRequestContextDep,
) -> HealthResponse:
    """Authenticated operational diagnostics."""
    service_health = await services.health()
    environment = _safe_setting(services.settings, "ENVIRONMENT", "development")
    dependencies = _build_dependency_health(service_health, production=_is_production(environment))
    return HealthResponse(
        status=_overall_state(dependencies),
        project_name="MindPal",
        version=_safe_setting(services.settings, "VERSION", "1.0.0"),
        environment=environment,
        dependencies=dependencies,
    )


@router.get("/rag/health")
async def rag_health(
    services: ServicesDep,
    context: AdminRequestContextDep,
) -> dict[str, Any]:
    return services.rag.health()


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
    elif db_provider == "firebase" and not db_provider_configured:
        db_state = HealthState.ERROR if production else HealthState.DEGRADED
    else:
        db_state = HealthState.OK

    dependencies.append(
        DependencyHealth(
            name="db",
            state=db_state,
            enabled=True,
            detail=(
                f"provider={db_provider}; mock_mode={db_mock_mode}; "
                f"configured={db_provider_configured}"
                + (f"; database_id={db_database_id}" if db_database_id else "")
                + (f"; project_id={db_project_id}" if db_project_id else "")
                + (f"; init_error={db_init_error}" if db_init_error else "")
            ),
        )
    )

    for name in ("llm", "memory", "output_guard", "rag", "safety", "tts"):
        info = _as_dict(service_health.get(name))
        is_ok = bool(info.get("configured", True) or info.get("status") == "ok" or info.get("ready", True))
        dependencies.append(
            DependencyHealth(
                name=name,
                state=HealthState.OK if is_ok else HealthState.DEGRADED,
                enabled=bool(info.get("enabled", True)),
                detail=_safe_value(info.get("detail") or info.get("provider") or info.get("model"), "ok"),
            )
        )

    return dependencies


def _overall_state(dependencies: list[DependencyHealth]) -> HealthState:
    if any(item.state == HealthState.ERROR for item in dependencies):
        return HealthState.ERROR
    if any(item.state == HealthState.DEGRADED for item in dependencies):
        return HealthState.DEGRADED
    return HealthState.OK


def _safe_setting(settings: object | None, name: str, default: str) -> str:
    return str(getattr(settings, name, default) or default)


def _is_production(env: str) -> bool:
    return env.strip().lower() == "production"


def _as_dict(value: object | None) -> dict[str, object]:
    return value if isinstance(value, dict) else {}


def _safe_value(value: object | None, default: str) -> str:
    return sanitize_text(str(value if value is not None else default), 160)


def _safe_optional(value: object | None) -> str | None:
    return sanitize_text(str(value), 160) if value else None
