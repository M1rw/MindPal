from __future__ import annotations

from .settings import get_settings

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
