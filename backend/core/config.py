# backend/core/config.py

from __future__ import annotations

import json

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


Environment = Literal["development", "test", "staging", "production"]


class Settings(BaseSettings):
    """
    Application configuration for MindPal.

    Design goals:
    - Safe defaults for local development.
    - Optional provider keys must not break startup.
    - Secrets are represented as SecretStr to reduce accidental exposure.
    - Production config rejects dangerous defaults such as wildcard CORS.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
        validate_assignment=True,
    )

    # App
    PROJECT_NAME: str = Field(default="MindPal", min_length=1, max_length=80)
    VERSION: str = Field(default="1.0.0", min_length=1, max_length=40)
    ENVIRONMENT: Environment = "development"

    # Server
    API_HOST: str = "0.0.0.0"
    API_PORT: int = Field(default=8000, ge=1, le=65535)

    # Security / CORS
    CORS_ORIGINS: list[str] = Field(
        default_factory=lambda: [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
        ]
    )

    # Provider secrets - all optional
    GEMINI_API_KEY: SecretStr | None = Field(default=None, repr=False)
    OPENROUTER_API_KEY: SecretStr | None = Field(default=None, repr=False)
    GROQ_API_KEY: SecretStr | None = Field(default=None, repr=False)
    PERSPECTIVE_API_KEY: SecretStr | None = Field(default=None, repr=False)
    CAMB_API_KEY: SecretStr | None = Field(default=None, repr=False)

    # Firebase
    FIREBASE_CREDENTIALS_PATH: str | None = None

    # Feature flags
    ENABLE_FIREBASE: bool = False
    ENABLE_PERSPECTIVE: bool = False
    ENABLE_TTS: bool = False

    # Privacy / logging
    LOG_RAW_MESSAGES: bool = False

    # Limits / timeouts
    REQUEST_TIMEOUT_SECONDS: float = Field(default=20.0, gt=0, le=120)
    LLM_TIMEOUT_SECONDS: float = Field(default=15.0, gt=0, le=120)
    MAX_MESSAGE_CHARS: int = Field(default=4_000, ge=100, le=50_000)
    MAX_HISTORY_MESSAGES: int = Field(default=10, ge=0, le=100)
    MEMORY_SUMMARY_MAX_CHARS: int = Field(default=4_000, ge=500, le=50_000)

    @field_validator("PROJECT_NAME", "VERSION", "API_HOST", mode="before")
    @classmethod
    def _strip_required_strings(cls, value: object) -> object:
        if isinstance(value, str):
            value = value.strip()
        return value

    @field_validator(
        "GEMINI_API_KEY",
        "OPENROUTER_API_KEY",
        "GROQ_API_KEY",
        "PERSPECTIVE_API_KEY",
        "CAMB_API_KEY",
        mode="before",
    )
    @classmethod
    def _empty_secret_to_none(cls, value: object) -> object:
        if value is None:
            return None
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("FIREBASE_CREDENTIALS_PATH", mode="before")
    @classmethod
    def _empty_path_to_none(cls, value: object) -> object:
        if value is None:
            return None
        if isinstance(value, str):
            value = value.strip()
            return value or None
        return value

    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def _parse_cors_origins(cls, value: object) -> list[str]:
        """
        Accepts:
        - comma-separated env string:
          CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
        - JSON-style list injected by pydantic-settings
        - Python list
        """
        if value is None:
            return []

        if isinstance(value, str):
            value = value.strip()
            if not value:
                return []

            # Common .env format: comma-separated origins
            if "," in value:
                return [origin.strip() for origin in value.split(",") if origin.strip()]

            return [value]

        if isinstance(value, list):
            return [str(origin).strip() for origin in value if str(origin).strip()]

        raise TypeError("CORS_ORIGINS must be a comma-separated string or list of strings")


    @field_validator(
        "TRUSTED_HOSTS",
        "CORS_ALLOW_ORIGINS",
        "CORS_ALLOW_METHODS",
        "CORS_ALLOW_HEADERS",
        "CORS_ORIGINS",
        mode="before",
    )
    @classmethod
    def _parse_env_list(cls, value: object) -> list[str]:
        if value is None:
            return []

        if isinstance(value, list):
            return [str(item).strip() for item in value if str(item).strip()]

        if isinstance(value, tuple | set):
            return [str(item).strip() for item in value if str(item).strip()]

        raw = str(value or "").strip()

        if not raw:
            return []

        if raw.startswith("["):
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                parsed = None

            if isinstance(parsed, list):
                return [str(item).strip() for item in parsed if str(item).strip()]

        return [part.strip() for part in raw.split(",") if part.strip()]

    @model_validator(mode="after")
    def _validate_safe_config(self) -> Settings:
        if self.is_production:
            if "*" in self.CORS_ORIGINS:
                raise ValueError("Wildcard CORS is not allowed in production")

            if self.LOG_RAW_MESSAGES:
                raise ValueError("LOG_RAW_MESSAGES must remain false in production")

        if self.ENABLE_FIREBASE and not self.FIREBASE_CREDENTIALS_PATH:
            raise ValueError(
                "ENABLE_FIREBASE=true requires FIREBASE_CREDENTIALS_PATH to be set"
            )

        if self.ENABLE_PERSPECTIVE and not self.has_perspective:
            raise ValueError(
                "ENABLE_PERSPECTIVE=true requires PERSPECTIVE_API_KEY to be set"
            )

        if self.ENABLE_TTS and not self.has_camb:
            raise ValueError("ENABLE_TTS=true requires CAMB_API_KEY to be set")

        return self

    @property
    def is_development(self) -> bool:
        return self.ENVIRONMENT == "development"

    @property
    def is_test(self) -> bool:
        return self.ENVIRONMENT == "test"

    @property
    def is_staging(self) -> bool:
        return self.ENVIRONMENT == "staging"

    @property
    def is_production(self) -> bool:
        return self.ENVIRONMENT == "production"

    @property
    def firebase_enabled(self) -> bool:
        return bool(self.ENABLE_FIREBASE and self.FIREBASE_CREDENTIALS_PATH)

    @property
    def perspective_enabled(self) -> bool:
        return bool(self.ENABLE_PERSPECTIVE and self.has_perspective)

    @property
    def tts_enabled(self) -> bool:
        return bool(self.ENABLE_TTS and self.has_camb)

    @property
    def has_gemini(self) -> bool:
        return _has_secret(self.GEMINI_API_KEY)

    @property
    def has_openrouter(self) -> bool:
        return _has_secret(self.OPENROUTER_API_KEY)

    @property
    def has_groq(self) -> bool:
        return _has_secret(self.GROQ_API_KEY)

    @property
    def has_perspective(self) -> bool:
        return _has_secret(self.PERSPECTIVE_API_KEY)

    @property
    def has_camb(self) -> bool:
        return _has_secret(self.CAMB_API_KEY)

    @property
    def firebase_credentials_file(self) -> Path | None:
        if not self.FIREBASE_CREDENTIALS_PATH:
            return None
        return Path(self.FIREBASE_CREDENTIALS_PATH).expanduser().resolve()


def _has_secret(value: SecretStr | None) -> bool:
    if value is None:
        return False
    return bool(value.get_secret_value().strip())


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()