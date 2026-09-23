from __future__ import annotations

from .settings import get_settings

APP_ENV_KEYS = {
    "ENVIRONMENT": "ENVIRONMENT",
    "DEBUG": "DEBUG",
    "ALLOWED_HOSTS": "MINDPAL_ALLOWED_HOSTS",
    "CORS_ORIGINS": "MINDPAL_CORS_ORIGINS",
    "PUBLIC_API_BASE_URL": "PUBLIC_API_BASE_URL",
}


def app_environment(default: str = "production") -> str:
    return (get_settings().environment or default).strip().lower() or default


def is_production() -> bool:
    return app_environment("production") not in {"development", "dev", "test", "testing", "local"}


def csv_env(name: str) -> list[str]:
    settings = get_settings()
    values = {
        "MINDPAL_ALLOWED_HOSTS": settings.allowed_hosts,
        "MINDPAL_CORS_ORIGINS": settings.cors_origins,
    }
    return [item.strip() for item in values.get(name, "").split(",") if item.strip()]
