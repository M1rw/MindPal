from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import List

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

    CORS_ORIGINS: List[str] = ["http://localhost:3000", "http://127.0.0.1:3000"]

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

settings = Settings()