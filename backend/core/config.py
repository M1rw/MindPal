from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import field_validator
from typing import List

from functools import lru_cache

class Settings(BaseSettings):
    PROJECT_NAME: str = "MindPal"
    VERSION: str = "1.0.0"
    ENVIRONMENT: str = "development"
    API_HOST: str = "0.0.0.0"
    API_PORT: int = 8000

    GEMINI_API_KEY: str = ""
    OPENROUTER_API_KEY: str = ""
    GROQ_API_KEY: str = ""
    PERSPECTIVE_API_KEY: str = ""
    CAMB_API_KEY: str = ""

    FIREBASE_CREDENTIALS_PATH: str = ""
    ENABLE_FIREBASE: bool = False
    ENABLE_PERSPECTIVE: bool = False
    ENABLE_TTS: bool = False
    LOG_RAW_MESSAGES: bool = False

    REQUEST_TIMEOUT_SECONDS: int = 15
    LLM_TIMEOUT_SECONDS: int = 10
    MAX_MESSAGE_CHARS: int = 1000
    MAX_HISTORY_MESSAGES: int = 20
    MEMORY_SUMMARY_MAX_CHARS: int = 2000

    CORS_ORIGINS: List[str] = ["http://localhost:3000", "http://127.0.0.1:3000"]

    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def assemble_cors_origins(cls, v: str | List[str]) -> List[str]:
        if isinstance(v, str):
            return [i.strip() for i in v.split(",") if i.strip()]
        return v

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    @property
    def is_development(self) -> bool:
        return self.ENVIRONMENT.lower() == "development"

    @property
    def is_production(self) -> bool:
        return self.ENVIRONMENT.lower() == "production"

    @property
    def firebase_enabled(self) -> bool:
        return self.ENABLE_FIREBASE and bool(self.FIREBASE_CREDENTIALS_PATH)

    @property
    def perspective_enabled(self) -> bool:
        return self.ENABLE_PERSPECTIVE and bool(self.PERSPECTIVE_API_KEY)

    @property
    def tts_enabled(self) -> bool:
        return self.ENABLE_TTS and bool(self.CAMB_API_KEY)

    @property
    def has_gemini(self) -> bool:
        return bool(self.GEMINI_API_KEY)

    @property
    def has_openrouter(self) -> bool:
        return bool(self.OPENROUTER_API_KEY)

    @property
    def has_groq(self) -> bool:
        return bool(self.GROQ_API_KEY)

@lru_cache()
def get_settings() -> Settings:
    return Settings()

settings = get_settings()