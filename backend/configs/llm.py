from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional

from .settings import get_settings

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
GROQ_BASE_URL = "https://api.groq.com/openai/v1"
DEFAULT_GEMINI_CHAT_MODEL = "gemini-2.5-flash"
DEFAULT_GEMINI_JSON_MODEL = "gemini-2.5-flash-lite"

DEFAULT_OPENROUTER_CHAT_MODEL = "meta-llama/llama-3.3-70b-instruct"
DEFAULT_OPENROUTER_JSON_MODEL = "meta-llama/llama-3.3-70b-instruct"
DEFAULT_GROQ_CHAT_MODEL = "qwen/qwen3.8-27b"
DEFAULT_GROQ_JSON_MODEL = "qwen/qwen3.8-27b"


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


# ---------------------------------------------------------------------------
# OpenAI-compatible providers
#
# Every provider here speaks /chat/completions with a Bearer key, so adding one
# is a registry entry, not new transport code. Free tiers are rate limited per
# key (and on Groq per model), which is why the gateway walks a ladder of them.
# Model ids drift: each default is overridable by env (<PROVIDER>_MODEL), and a
# provider stays inert until its key is set.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CompatibleProvider:
    name: str
    base_url: Callable[[], str]
    api_key: Callable[[], str]
    chat_model: Callable[[], str]
    json_model: Callable[[], str]


def _secret(field: str) -> Callable[[], str]:
    return lambda: getattr(get_settings(), field).get_secret_value().strip()


def _model(field: str, default: str) -> Callable[[], str]:
    return lambda: getattr(get_settings(), field).strip() or default


COMPATIBLE_PROVIDERS: dict[str, CompatibleProvider] = {
    "openrouter": CompatibleProvider("openrouter", openrouter_base_url, openrouter_api_key, openrouter_chat_model, openrouter_json_model),
    "groq": CompatibleProvider("groq", groq_base_url, groq_api_key, groq_chat_model, groq_json_model),
    "cerebras": CompatibleProvider(
        "cerebras", lambda: "https://api.cerebras.ai/v1", _secret("cerebras_api_key"),
        _model("cerebras_model", "llama-3.3-70b"), _model("cerebras_model", "llama-3.3-70b"),
    ),
    "sambanova": CompatibleProvider(
        "sambanova", lambda: "https://api.sambanova.ai/v1", _secret("sambanova_api_key"),
        _model("sambanova_model", "Meta-Llama-3.3-70B-Instruct"), _model("sambanova_model", "Meta-Llama-3.3-70B-Instruct"),
    ),
    "mistral": CompatibleProvider(
        "mistral", lambda: "https://api.mistral.ai/v1", _secret("mistral_api_key"),
        _model("mistral_model", "mistral-small-latest"), _model("mistral_model", "mistral-small-latest"),
    ),
}


def compatible_provider(name: str) -> Optional[CompatibleProvider]:
    return COMPATIBLE_PROVIDERS.get((name or "").strip().lower())
