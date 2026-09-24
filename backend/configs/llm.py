from __future__ import annotations

from .settings import get_settings

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
GROQ_BASE_URL = "https://api.groq.com/openai/v1"
DEFAULT_GEMINI_CHAT_MODEL = "gemini-2.5-flash"
DEFAULT_GEMINI_JSON_MODEL = "gemini-2.5-flash-lite"

DEFAULT_OPENROUTER_CHAT_MODEL = "meta-llama/llama-3.3-70b-instruct"
DEFAULT_OPENROUTER_JSON_MODEL = "meta-llama/llama-3.3-70b-instruct"
DEFAULT_GROQ_CHAT_MODEL = "qwen/qwen3.8-27b"
DEFAULT_GROQ_JSON_MODEL = "qwen/qwen3.8-27b"
DEFAULT_GROQ_STT_MODEL = "whisper-large-v3-turbo"


def openrouter_api_key() -> str:
    return get_settings().openrouter_api_key.get_secret_value().strip()


def groq_api_key() -> str:
    return get_settings().groq_api_key.get_secret_value().strip()


def openrouter_base_url() -> str:
    return get_settings().openrouter_base_url.strip() or OPENROUTER_BASE_URL


def groq_base_url() -> str:
    return get_settings().groq_base_url.strip() or GROQ_BASE_URL


def openrouter_chat_model() -> str:
    return get_settings().openrouter_model.strip() or DEFAULT_OPENROUTER_CHAT_MODEL


def openrouter_json_model() -> str:
    settings = get_settings()
    return settings.openrouter_json_model.strip() or settings.openrouter_model.strip() or DEFAULT_OPENROUTER_JSON_MODEL


def groq_chat_model() -> str:
    return get_settings().groq_model.strip() or DEFAULT_GROQ_CHAT_MODEL


def groq_json_model() -> str:
    settings = get_settings()
    return settings.groq_json_model.strip() or settings.groq_model.strip() or DEFAULT_GROQ_JSON_MODEL


def groq_stt_model() -> str:
    return get_settings().groq_stt_model.strip() or DEFAULT_GROQ_STT_MODEL
