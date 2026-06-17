# backend/core/config.py

"""
Application configuration for MindPal.

All environment variables consumed anywhere in the backend MUST be declared here
as typed fields. Raw os.getenv() calls in service code are prohibited — they
bypass validation, type coercion, and the production safety validator.

Design goals:
- Safe defaults for local development
- Optional provider keys must not break startup
- Secrets are SecretStr to reduce accidental exposure
- Production config rejects dangerous defaults (wildcard CORS, raw message logging)
- Testable: settings can be reset via reset_settings()
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


Environment = Literal["development", "test", "staging", "production"]


class Settings(BaseSettings):
    """
    Typed, validated application settings.

    Every env var the backend reads must be declared here. If you need a new
    env var, add it as a field — never use raw os.getenv().
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
        validate_assignment=True,
    )

    # ── App ──────────────────────────────────────────────────────
    PROJECT_NAME: str = Field(default="MindPal", min_length=1, max_length=80)
    VERSION: str = Field(default="1.0.0", min_length=1, max_length=40)
    ENVIRONMENT: Environment = "development"

    # ── Server ───────────────────────────────────────────────────
    API_HOST: str = "0.0.0.0"
    API_PORT: int = Field(default=8000, ge=1, le=65535)

    # ── Security / CORS ──────────────────────────────────────────
    CORS_ORIGINS: list[str] = Field(
        default_factory=lambda: [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
        ]
    )

    # ── LLM Provider Secrets ─────────────────────────────────────
    GEMINI_API_KEY: SecretStr | None = Field(default=None, repr=False)
    OPENROUTER_API_KEY: SecretStr | None = Field(default=None, repr=False)
    GROQ_API_KEY: SecretStr | None = Field(default=None, repr=False)

    # ── Cloudflare AI ────────────────────────────────────────────
    CLOUDFLARE_AIG_TOKEN: SecretStr | None = Field(default=None, repr=False)
    CLOUDFLARE_API_TOKEN: SecretStr | None = Field(default=None, repr=False)
    CLOUDFLARE_ACCOUNT_ID: str = Field(default="")
    CLOUDFLARE_GATEWAY_ID: str = Field(default="default")
    CLOUDFLARE_MODEL: str = Field(default="workers-ai/@cf/meta/llama-3.1-8b-instruct-fp8-fast")
    CLOUDFLARE_AI_MODE: str = Field(default="gateway_compat")
    CLOUDFLARE_AI_GATEWAY_URL: str = Field(default="")
    CLOUDFLARE_AI_GATEWAY_BASE_URL: str = Field(default="https://gateway.ai.cloudflare.com")
    CLOUDFLARE_AI_NATIVE_BASE_URL: str = Field(default="https://api.cloudflare.com/client/v4")
    CLOUDFLARE_TIMEOUT_SECONDS: float = Field(default=20.0, gt=0, le=120)

    # ── Safety / External APIs ───────────────────────────────────
    PERSPECTIVE_API_KEY: SecretStr | None = Field(default=None, repr=False)
    CAMB_API_KEY: SecretStr | None = Field(default=None, repr=False)

    # ── LLM Provider Order ───────────────────────────────────────
    LLM_PROVIDER_ORDER: str = Field(default="gemini,cloudflare,openrouter,groq")

    # ── Firebase ─────────────────────────────────────────────────
    # All Firebase env vars that were previously read via os.getenv() in
    # db_service.py are now declared here for consistent validation.
    FIREBASE_CREDENTIALS_PATH: str | None = None
    FIREBASE_CREDENTIALS_JSON: SecretStr | None = Field(default=None, repr=False)
    FIREBASE_APP_NAME: str = Field(default="mindpal")
    FIREBASE_PROJECT_ID: str | None = None
    FIREBASE_USE_APPLICATION_DEFAULT: bool = False
    FIRESTORE_DATABASE_ID: str = Field(default="default")

    # ── Google Cloud (used by Firebase + ADC) ────────────────────
    GOOGLE_CLOUD_PROJECT: str | None = None
    GOOGLE_APPLICATION_CREDENTIALS: str | None = None

    # ── Feature Flags ────────────────────────────────────────────
    ENABLE_FIREBASE: bool = False
    ENABLE_PERSPECTIVE: bool = False
    ENABLE_TTS: bool = False

    # Service-level feature flags (previously read via os.getenv in dependencies.py)
    ALLOW_ANONYMOUS_SESSIONS: bool = True
    ENABLE_OFFLINE_LLM_FALLBACK: bool = True
    ENABLE_BROWSER_TTS_FALLBACK: bool = True
    ENABLE_LLM_MEMORY_SUMMARIZATION: bool = True
    ENABLE_LLM_OUTPUT_REWRITE: bool = True
    ENABLE_LLM_RAG_PLANNING: bool = True
    ENABLE_LLM_SAFETY_CLASSIFIER: bool = True

    # LLM policy flags (previously read via os.getenv in llm_service.py)
    REQUIRE_REMOTE_LLM_PROVIDER: bool = False
    ALLOW_OFFLINE_LLM_IN_PRODUCTION: bool = False

    # Firebase auth flags (previously read via os.getenv in auth_service.py)
    FIREBASE_CHECK_REVOKED_TOKENS: bool = False

    # ── Privacy / Logging ────────────────────────────────────────
    LOG_RAW_MESSAGES: bool = False

    # ── Limits / Timeouts ────────────────────────────────────────
    REQUEST_TIMEOUT_SECONDS: float = Field(default=20.0, gt=0, le=120)
    LLM_TIMEOUT_SECONDS: float = Field(default=15.0, gt=0, le=120)
    MAX_MESSAGE_CHARS: int = Field(default=4_000, ge=100, le=50_000)
    MAX_HISTORY_MESSAGES: int = Field(default=10, ge=0, le=100)
    MEMORY_SUMMARY_MAX_CHARS: int = Field(default=4_000, ge=500, le=50_000)

    # ─────────────────────────────────────────────────────────────
    # Validators
    # ─────────────────────────────────────────────────────────────

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
        "CLOUDFLARE_API_TOKEN",
        "CLOUDFLARE_AIG_TOKEN",
        "PERSPECTIVE_API_KEY",
        "CAMB_API_KEY",
        "FIREBASE_CREDENTIALS_JSON",
        mode="before",
    )
    @classmethod
    def _empty_secret_to_none(cls, value: object) -> object:
        if value is None:
            return None
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator(
        "FIREBASE_CREDENTIALS_PATH",
        "FIREBASE_PROJECT_ID",
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_APPLICATION_CREDENTIALS",
        mode="before",
    )
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

    @model_validator(mode="after")
    def _validate_safe_config(self) -> Settings:
        if self.is_production:
            if "*" in self.CORS_ORIGINS:
                raise ValueError("Wildcard CORS is not allowed in production")

            if self.LOG_RAW_MESSAGES:
                raise ValueError("LOG_RAW_MESSAGES must remain false in production")

        if self.ENABLE_FIREBASE and not self._has_any_firebase_credentials:
            raise ValueError(
                "ENABLE_FIREBASE=true requires at least one of: "
                "FIREBASE_CREDENTIALS_PATH, FIREBASE_CREDENTIALS_JSON, "
                "or FIREBASE_USE_APPLICATION_DEFAULT=true"
            )

        if self.ENABLE_PERSPECTIVE and not self.has_perspective:
            raise ValueError(
                "ENABLE_PERSPECTIVE=true requires PERSPECTIVE_API_KEY to be set"
            )

        if self.ENABLE_TTS and not self.has_camb:
            raise ValueError("ENABLE_TTS=true requires CAMB_API_KEY to be set")

        return self

    # ─────────────────────────────────────────────────────────────
    # Environment Properties
    # ─────────────────────────────────────────────────────────────

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

    # ─────────────────────────────────────────────────────────────
    # Feature Properties
    # ─────────────────────────────────────────────────────────────

    @property
    def firebase_enabled(self) -> bool:
        return bool(self.ENABLE_FIREBASE and self._has_any_firebase_credentials)

    @property
    def perspective_enabled(self) -> bool:
        return bool(self.ENABLE_PERSPECTIVE and self.has_perspective)

    @property
    def tts_enabled(self) -> bool:
        return bool(self.ENABLE_TTS and self.has_camb)

    # ─────────────────────────────────────────────────────────────
    # Provider Availability Properties
    # ─────────────────────────────────────────────────────────────

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
    def has_cloudflare(self) -> bool:
        return _has_secret(self.CLOUDFLARE_AIG_TOKEN) or _has_secret(self.CLOUDFLARE_API_TOKEN)

    @property
    def has_perspective(self) -> bool:
        return _has_secret(self.PERSPECTIVE_API_KEY)

    @property
    def has_camb(self) -> bool:
        return _has_secret(self.CAMB_API_KEY)

    @property
    def has_any_llm_provider(self) -> bool:
        """True if at least one LLM provider has credentials configured."""
        return any([self.has_gemini, self.has_openrouter, self.has_groq, self.has_cloudflare])

    # ─────────────────────────────────────────────────────────────
    # Derived Properties
    # ─────────────────────────────────────────────────────────────

    @property
    def parsed_llm_provider_order(self) -> list[str]:
        """
        Parse LLM_PROVIDER_ORDER into a validated list of provider names.

        Returns only recognized provider names in the declared order.
        """
        recognized = {"gemini", "cloudflare", "openrouter", "groq"}
        raw = str(self.LLM_PROVIDER_ORDER or "").strip()
        if not raw:
            return ["gemini", "cloudflare", "openrouter", "groq"]

        providers: list[str] = []
        seen: set[str] = set()
        for name in raw.split(","):
            clean = name.strip().lower()
            if clean in recognized and clean not in seen:
                providers.append(clean)
                seen.add(clean)

        return providers or ["gemini", "cloudflare", "openrouter", "groq"]

    @property
    def firebase_credentials_file(self) -> Path | None:
        if not self.FIREBASE_CREDENTIALS_PATH:
            return None
        return Path(self.FIREBASE_CREDENTIALS_PATH).expanduser().resolve()

    @property
    def resolved_firebase_project_id(self) -> str:
        """Return the Firebase project ID from any configured source."""
        return (
            (self.FIREBASE_PROJECT_ID or "").strip()
            or (self.GOOGLE_CLOUD_PROJECT or "").strip()
        )

    @property
    def _has_any_firebase_credentials(self) -> bool:
        return bool(
            self.FIREBASE_CREDENTIALS_PATH
            or _has_secret(self.FIREBASE_CREDENTIALS_JSON)
            or self.GOOGLE_APPLICATION_CREDENTIALS
            or self.FIREBASE_USE_APPLICATION_DEFAULT
        )


# ═══════════════════════════════════════════════════════════════
# Module-level helpers
# ═══════════════════════════════════════════════════════════════

def _has_secret(value: SecretStr | None) -> bool:
    if value is None:
        return False
    return bool(value.get_secret_value().strip())


# ── Settings Singleton ───────────────────────────────────────────
# Using a module-level variable instead of @lru_cache so tests can
# reset state via reset_settings() without cache invalidation issues.

_settings_instance: Settings | None = None


def get_settings() -> Settings:
    """
    Return the singleton Settings instance.

    On first call, creates a new Settings() from environment/.env.
    Subsequent calls return the cached instance.
    Use reset_settings() in tests to clear the cache.
    """
    global _settings_instance
    if _settings_instance is None:
        _settings_instance = Settings()
    return _settings_instance


def reset_settings() -> None:
    """
    Clear the cached settings instance.

    Intended for tests only. After calling this, the next get_settings()
    will re-read from environment/.env.
    """
    global _settings_instance
    _settings_instance = None