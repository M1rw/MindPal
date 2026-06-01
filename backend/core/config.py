from typing import Optional
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    PROJECT_NAME: str = "MindPal"
    VERSION: str = "1.0.0"
    
    # Primary API Key (Required)
    GEMINI_API_KEY: str
    
    # Fallback API Keys (Optional - won't crash if missing)
    OPENROUTER_API_KEY: Optional[str] = None
    GROQ_API_KEY: Optional[str] = None
    
    # Database
    FIREBASE_CREDENTIALS_PATH: Optional[str] = None

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore"  # Ignores extra variables in the .env file instead of crashing
    )

settings = Settings()