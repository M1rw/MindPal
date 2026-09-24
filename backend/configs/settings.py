from __future__ import annotations

import os
import threading
from typing import Any

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


STORAGE_PROVIDERS = frozenset({'firestore', 'supabase', 'memory'})


class Settings(BaseSettings):
    """Validated runtime configuration for the backend.

    Environment variables are read here only. Feature modules should consume
    this object through ``get_settings`` instead of reading process state.
    """

    model_config = SettingsConfigDict(
        env_file=('.env', '.env.local'),
        env_file_encoding='utf-8',
        extra='ignore',
        case_sensitive=True,
    )

    environment: str = Field(default='production', validation_alias='ENVIRONMENT')
    vercel: str = Field(default='', validation_alias='VERCEL')
    public_api_base_url: str = Field(default='/api', validation_alias='PUBLIC_API_BASE_URL')
    allowed_hosts: str = Field(default='', validation_alias='MINDPAL_ALLOWED_HOSTS')
    cors_origins: str = Field(default='', validation_alias='MINDPAL_CORS_ORIGINS')
    enable_firebase: bool = Field(default=True, validation_alias='ENABLE_FIREBASE')
    firebase_check_revoked_tokens: bool = Field(default=True, validation_alias='FIREBASE_CHECK_REVOKED_TOKENS')
    firebase_app_name: str = Field(default='mindpal', validation_alias='FIREBASE_APP_NAME')
    firebase_credentials_base64: str = Field(default='', validation_alias='FIREBASE_CREDENTIALS_BASE64')
    firebase_credentials_json: str = Field(default='', validation_alias='FIREBASE_CREDENTIALS_JSON')
    firebase_credentials_path: str = Field(default='', validation_alias='FIREBASE_CREDENTIALS_PATH')
    google_application_credentials: str = Field(default='', validation_alias='GOOGLE_APPLICATION_CREDENTIALS')
    firebase_use_application_default: bool = Field(default=False, validation_alias='FIREBASE_USE_APPLICATION_DEFAULT')
    firestore_database_id: str = Field(default='(default)', validation_alias='FIRESTORE_DATABASE_ID')

    storage_provider: str = Field(default='', validation_alias='MINDPAL_STORAGE_PROVIDER')
    supabase_url: str = Field(default='', validation_alias='SUPABASE_URL')
    supabase_service_role_key: SecretStr = Field(default=SecretStr(''), validation_alias='SUPABASE_SERVICE_ROLE_KEY')

    openrouter_api_key: SecretStr = Field(default=SecretStr(''), validation_alias='OPENROUTER_API_KEY')
    groq_api_key: SecretStr = Field(default=SecretStr(''), validation_alias='GROQ_API_KEY')
    openrouter_base_url: str = Field(default='https://openrouter.ai/api/v1', validation_alias='OPENROUTER_BASE_URL')
    groq_base_url: str = Field(default='https://api.groq.com/openai/v1', validation_alias='GROQ_BASE_URL')
    openrouter_model: str = Field(default='meta-llama/llama-3.3-70b-instruct', validation_alias='OPENROUTER_MODEL')
    openrouter_json_model: str = Field(default='', validation_alias='OPENROUTER_JSON_MODEL')
    groq_model: str = Field(default='qwen/qwen3.8-27b', validation_alias='GROQ_MODEL')
    groq_json_model: str = Field(default='', validation_alias='GROQ_JSON_MODEL')
    groq_stt_model: str = Field(default='', validation_alias='GROQ_STT_MODEL')
    # More OpenAI-compatible providers with free tiers. Inert until a key is set;
    # list them in MINDPAL_LLM_FALLBACK to use them (see backend/configs/llm.py).
    cerebras_api_key: SecretStr = Field(default=SecretStr(''), validation_alias='CEREBRAS_API_KEY')
    cerebras_model: str = Field(default='', validation_alias='CEREBRAS_MODEL')
    sambanova_api_key: SecretStr = Field(default=SecretStr(''), validation_alias='SAMBANOVA_API_KEY')
    sambanova_model: str = Field(default='', validation_alias='SAMBANOVA_MODEL')
    mistral_api_key: SecretStr = Field(default=SecretStr(''), validation_alias='MISTRAL_API_KEY')
    mistral_model: str = Field(default='', validation_alias='MISTRAL_MODEL')
    gemini_api_key: SecretStr = Field(default=SecretStr(''), validation_alias='GEMINI_API_KEY')
    google_api_key: SecretStr = Field(default=SecretStr(''), validation_alias='GOOGLE_API_KEY')
    gemini_model: str = Field(default='gemini-2.5-flash', validation_alias='GEMINI_MODEL')
    gemini_json_model: str = Field(default='gemini-2.5-flash-lite', validation_alias='GEMINI_JSON_MODEL')
    openrouter_app_url: str = Field(default='', validation_alias='OPENROUTER_APP_URL')
    openrouter_app_title: str = Field(default='MindPal', validation_alias='OPENROUTER_APP_TITLE')
    llm_provider: str = Field(default='', validation_alias='MINDPAL_LLM_PROVIDER')
    chat_provider: str = Field(default='', validation_alias='MINDPAL_CHAT_PROVIDER')
    json_provider: str = Field(default='', validation_alias='MINDPAL_JSON_PROVIDER')
    llm_fallback: str = Field(default='', validation_alias='MINDPAL_LLM_FALLBACK')

    voice_live: str = Field(default='', validation_alias='MINDPAL_VOICE_LIVE')
    voice_live_allowlist: str = Field(default='', validation_alias='MINDPAL_VOICE_LIVE_ALLOWLIST')
    presence: str = Field(default='', validation_alias='MINDPAL_PRESENCE')
    presence_allowlist: str = Field(default='', validation_alias='MINDPAL_PRESENCE_ALLOWLIST')
    voice_classifier: str = Field(default='', validation_alias='MINDPAL_VOICE_CLASSIFIER')
    voice_provider_rotate_s: str = Field(default='', validation_alias='MINDPAL_VOICE_PROVIDER_ROTATE_S')
    voice_retention_cron_secret: str = Field(default='', validation_alias='MINDPAL_VOICE_RETENTION_CRON_SECRET')
    # Vercel Cron sends `Authorization: Bearer $CRON_SECRET`; accept it as the scheduler credential.
    cron_secret: str = Field(default='', validation_alias='CRON_SECRET')
    adaptive_learning: str = Field(default='1', validation_alias='MINDPAL_ADAPTIVE_LEARNING')
    semantic_search: str = Field(default='1', validation_alias='MINDPAL_SEMANTIC_SEARCH')
    voice_support_diagnostics_secret: str = Field(default='', validation_alias='MINDPAL_VOICE_SUPPORT_DIAGNOSTICS_SECRET')
    voice_safety_settings: str = Field(default='1', validation_alias='MINDPAL_VOICE_SAFETY_SETTINGS')
    voice_proactive_audio: str = Field(default='', validation_alias='MINDPAL_VOICE_PROACTIVE_AUDIO')
    gemini_live_model: str = Field(default='gemini-3.8-live', validation_alias='GEMINI_LIVE_MODEL')
    gemini_live_voice: str = Field(default='Sulafat', validation_alias='GEMINI_LIVE_VOICE')

    firebase_web_api_key: str = Field(default='', validation_alias='FIREBASE_WEB_API_KEY')
    firebase_api_key: str = Field(default='', validation_alias='FIREBASE_API_KEY')
    firebase_web_project_id: str = Field(default='', validation_alias='FIREBASE_WEB_PROJECT_ID')
    firebase_project_id: str = Field(default='', validation_alias='FIREBASE_PROJECT_ID')
    google_cloud_project: str = Field(default='', validation_alias='GOOGLE_CLOUD_PROJECT')
    firebase_web_app_id: str = Field(default='', validation_alias='FIREBASE_WEB_APP_ID')
    firebase_app_id: str = Field(default='', validation_alias='FIREBASE_APP_ID')
    firebase_auth_domain: str = Field(default='', validation_alias='FIREBASE_AUTH_DOMAIN')
    firebase_storage_bucket: str = Field(default='', validation_alias='FIREBASE_STORAGE_BUCKET')
    firebase_messaging_sender_id: str = Field(default='', validation_alias='FIREBASE_MESSAGING_SENDER_ID')
    firebase_measurement_id: str = Field(default='', validation_alias='FIREBASE_MEASUREMENT_ID')
    firebase_web_google_client_id: str = Field(default='', validation_alias='FIREBASE_WEB_GOOGLE_CLIENT_ID')
    firebase_appcheck_site_key: str = Field(default='', validation_alias='FIREBASE_APPCHECK_SITE_KEY')

    def configured_storage_provider(self) -> str:
        """Explicit choice wins; otherwise the durable store that is configured.

        Supabase is preferred when configured: it is the production store.
        Firebase Admin credentials alone do not prove a Firestore database
        exists (they are also needed for sign-in), so Firestore comes second.
        Memory is only chosen when nothing durable is configured, and the store
        logs that loudly.
        """
        explicit = self.storage_provider.strip().lower()
        if explicit in {'inmemory', 'in-memory'}:
            return 'memory'
        if explicit:
            return explicit
        url, key = self.supabase_settings()
        if url and key:
            return 'supabase'
        if self.has_firebase_admin_credentials():
            return 'firestore'
        return 'memory'

    def has_firebase_admin_credentials(self) -> bool:
        if not self.enable_firebase:
            return False
        path = self.firebase_credentials_path.strip() or self.google_application_credentials.strip()
        return bool(
            self.firebase_credentials_base64.strip()
            or self.firebase_credentials_json.strip()
            or (path and os.path.exists(path))
            or self.firebase_use_application_default
        )

    def validate_runtime(self) -> str:
        provider = self.configured_storage_provider()
        if provider not in STORAGE_PROVIDERS:
            raise ValueError(
                f"Unsupported MINDPAL_STORAGE_PROVIDER={provider!r}; choose one of {', '.join(sorted(STORAGE_PROVIDERS))}"
            )
        if provider == 'supabase':
            url, key = self.supabase_settings()
            if not url:
                raise ValueError('MINDPAL_STORAGE_PROVIDER=supabase requires SUPABASE_URL')
            if not key:
                raise ValueError('MINDPAL_STORAGE_PROVIDER=supabase requires SUPABASE_SERVICE_ROLE_KEY')
        if provider == 'firestore' and not self.enable_firebase:
            raise ValueError('MINDPAL_STORAGE_PROVIDER=firestore requires ENABLE_FIREBASE to be on')
        if provider == 'memory' and self.is_production_environment():
            # Per-process memory in production loses every write on restart and
            # makes each instance enforce its own chat and voice limits, while
            # readiness still said "ok". The app starts on UnavailableStore
            # instead: shell and sign-in work, data routes answer 503.
            raise ValueError(
                'Production needs durable storage: set MINDPAL_STORAGE_PROVIDER=supabase '
                '(with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY) or firestore. '
                'Memory storage is for development and tests only.'
            )
        return provider

    def is_production_environment(self) -> bool:
        return (self.environment or 'production').strip().lower() not in {'development', 'dev', 'test', 'testing', 'local'}

    def scheduler_secrets(self) -> set[str]:
        return {value.strip() for value in (self.voice_retention_cron_secret, self.cron_secret) if value.strip()}

    def semantic_search_enabled(self) -> bool:
        return self.semantic_search.strip().lower() not in {'0', 'false', 'no', 'off'}

    def adaptive_learning_enabled(self) -> bool:
        return self.adaptive_learning.strip().lower() not in {'0', 'false', 'no', 'off'}

    def supabase_settings(self) -> tuple[str, str]:
        return self.supabase_url.strip(), self.supabase_service_role_key.get_secret_value().strip()

    def resolved_gemini_api_key(self) -> str:
        return self.gemini_api_key.get_secret_value().strip() or self.google_api_key.get_secret_value().strip()

    def provider_override(self, name: str) -> str:
        values = {
            'MINDPAL_LLM_PROVIDER': self.llm_provider,
            'MINDPAL_CHAT_PROVIDER': self.chat_provider,
            'MINDPAL_JSON_PROVIDER': self.json_provider,
            'MINDPAL_LLM_FALLBACK': self.llm_fallback,
        }
        return values.get(name, '').strip().lower()

    def firebase_public_bootstrap(self) -> dict[str, Any]:
        api_key = self.firebase_web_api_key.strip() or self.firebase_api_key.strip()
        project_id = self.firebase_web_project_id.strip() or self.firebase_project_id.strip() or self.google_cloud_project.strip()
        app_id = self.firebase_web_app_id.strip() or self.firebase_app_id.strip()
        auth_domain = self.firebase_auth_domain.strip() or (f'{project_id}.firebaseapp.com' if project_id else '')
        storage_bucket = self.firebase_storage_bucket.strip() or (f'{project_id}.appspot.com' if project_id else '')
        firebase_ready = bool(self.enable_firebase and api_key and project_id and app_id)
        firebase_config = {
            'apiKey': api_key,
            'authDomain': auth_domain,
            'projectId': project_id,
            'storageBucket': storage_bucket,
            'messagingSenderId': self.firebase_messaging_sender_id.strip(),
            'appId': app_id,
            'measurementId': self.firebase_measurement_id.strip(),
            'googleClientId': self.firebase_web_google_client_id.strip(),
        } if firebase_ready else None
        return {
            'API_BASE_URL': self.public_api_base_url.strip() or '/api',
            'ENVIRONMENT': self.environment,
            'FIREBASE_APPCHECK_SITE_KEY': self.firebase_appcheck_site_key.strip(),
            'FIREBASE_CONFIG': firebase_config,
            'FIREBASE_ENABLED': firebase_ready,
        }


_CACHE_LOCK = threading.Lock()
_CACHE: tuple[int, Settings] | None = None


def _environment_fingerprint() -> int:
    # Hashing the environment is microseconds; building Settings re-reads the
    # .env files from disk (~10 ms). Keying the cache on the environment keeps
    # tests that patch variables correct without a manual reset.
    return hash(frozenset(os.environ.items()))


def get_settings() -> Settings:
    global _CACHE
    fingerprint = _environment_fingerprint()
    cached = _CACHE
    if cached is not None and cached[0] == fingerprint:
        return cached[1]
    with _CACHE_LOCK:
        cached = _CACHE
        if cached is not None and cached[0] == fingerprint:
            return cached[1]
        environment = os.environ.get('ENVIRONMENT', '').strip().lower()
        settings = Settings(_env_file=None) if environment in {'test', 'testing'} else Settings()
        _CACHE = (fingerprint, settings)
        return settings


def reset_settings_cache() -> None:
    """Drop the cached settings, e.g. after editing a .env file at runtime."""
    global _CACHE
    with _CACHE_LOCK:
        _CACHE = None
