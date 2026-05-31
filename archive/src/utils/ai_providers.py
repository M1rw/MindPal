from __future__ import annotations

from functools import lru_cache
import json
import logging
import os
import urllib.error
import urllib.request

from google import genai
from google.genai import errors as genai_errors
from google.genai import types


logger = logging.getLogger("mindpal.ai_providers")


def _normalize_model_id(model_id: str) -> str:
    return model_id.removeprefix("models/").strip()


def _pick_preferred_model(active_models: tuple[str, ...], preferred_models: tuple[str, ...]) -> str:
    active_lookup = {_normalize_model_id(model_id): model_id for model_id in active_models}

    for preferred_model in preferred_models:
        normalized = _normalize_model_id(preferred_model)
        if normalized and normalized in active_lookup:
            return active_lookup[normalized]

    return active_models[0]


def _build_hf_prompt(system_prompt: str, user_prompt: str) -> str:
    return f"System: {system_prompt}\n\nUser: {user_prompt}\n\nAssistant:"


@lru_cache(maxsize=1)
def _list_google_model_ids() -> tuple[str, ...]:
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        raise RuntimeError("GOOGLE_API_KEY is missing from the environment.")

    client = genai.Client(api_key=api_key)
    model_ids: list[str] = []

    for model in client.models.list():
        supported_methods = getattr(model, "supported_generation_methods", ()) or ()
        if "generateContent" in supported_methods:
            model_name = getattr(model, "name", None)
            if isinstance(model_name, str) and model_name:
                model_ids.append(_normalize_model_id(model_name))

    if not model_ids:
        raise RuntimeError("Google models API returned no active models.")

    return tuple(model_ids)


def select_google_model() -> str:
    active_models = _list_google_model_ids()
    configured_model = os.getenv("GEMINI_MODEL", "").strip()
    preferred_models = (configured_model, "gemini-2.5-flash", "gemini-2.0-flash")
    return _pick_preferred_model(active_models, preferred_models)


@lru_cache(maxsize=1)
def _list_openrouter_model_ids() -> tuple[str, ...]:
    api_token = os.getenv("OPENROUTER_API_KEY")
    if not api_token:
        raise RuntimeError("OPENROUTER_API_KEY is missing from the environment.")

    request = urllib.request.Request(
        "https://openrouter.ai/api/v1/models",
        headers={
            "Authorization": f"Bearer {api_token}",
            "Content-Type": "application/json",
        },
        method="GET",
    )

    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            raw_response = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        error_payload = error.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"OpenRouter models request failed: {error_payload or error.reason}") from error

    data = json.loads(raw_response)
    models = data.get("data") if isinstance(data, dict) else None
    if not isinstance(models, list):
        raise RuntimeError("Unexpected response from the OpenRouter models API.")

    model_ids: list[str] = []
    for model in models:
        if isinstance(model, dict):
            model_id = model.get("id")
            if isinstance(model_id, str) and model_id:
                model_ids.append(_normalize_model_id(model_id))

    if not model_ids:
        raise RuntimeError("OpenRouter models API returned no active models.")

    return tuple(model_ids)


def select_openrouter_model() -> str:
    active_models = _list_openrouter_model_ids()
    configured_model = os.getenv("OPENROUTER_MODEL", "").strip()
    preferred_models = (
        configured_model,
        "openai/gpt-4o-mini",
        "openai/gpt-4o",
        "anthropic/claude-3.5-sonnet",
        "meta-llama/llama-3.3-70b-instruct",
    )
    return _pick_preferred_model(active_models, preferred_models)


@lru_cache(maxsize=1)
def _list_groq_model_ids() -> tuple[str, ...]:
    api_token = os.getenv("GROQ_API_KEY")
    if not api_token:
        raise RuntimeError("GROQ_API_KEY is missing from the environment.")

    request = urllib.request.Request(
        "https://api.groq.com/openai/v1/models",
        headers={
            "Authorization": f"Bearer {api_token}",
            "Content-Type": "application/json",
        },
        method="GET",
    )

    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            raw_response = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        error_payload = error.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Groq models request failed: {error_payload or error.reason}") from error

    data = json.loads(raw_response)
    models = data.get("data") if isinstance(data, dict) else None
    if not isinstance(models, list):
        raise RuntimeError("Unexpected response from the Groq models API.")

    model_ids: list[str] = []
    for model in models:
        if isinstance(model, dict):
            model_id = model.get("id")
            if isinstance(model_id, str) and model_id:
                model_ids.append(_normalize_model_id(model_id))

    if not model_ids:
        raise RuntimeError("Groq models API returned no active models.")

    return tuple(model_ids)


def select_groq_model() -> str:
    active_models = _list_groq_model_ids()
    configured_model = os.getenv("GROQ_MODEL", "").strip()
    preferred_models = (
        configured_model,
        "llama-3.1-8b-instant",
        "llama-3.3-70b-versatile",
        "llama-3.1-70b-versatile",
        "meta-llama/llama-4-scout-17b-16e-instruct",
        "meta-llama/llama-4-maverick-17b-128e-instruct",
    )
    return _pick_preferred_model(active_models, preferred_models)


def generate_with_google(system_prompt: str, user_prompt: str) -> str:
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        raise RuntimeError("GOOGLE_API_KEY is missing from the environment.")

    client = genai.Client(api_key=api_key)
    model_name = select_google_model()
    response = client.models.generate_content(
        model=model_name,
        contents=f"System prompt:\n{system_prompt}\n\nUser input:\n{user_prompt}",
        config=types.GenerateContentConfig(
            temperature=0.4,
            top_p=0.9,
            max_output_tokens=350,
        ),
    )

    text = getattr(response, "text", None)
    if not text:
        raise RuntimeError("The Google API returned an empty response.")

    return str(text).strip()


def generate_with_openrouter(system_prompt: str, user_prompt: str) -> str:
    api_token = os.getenv("OPENROUTER_API_KEY")
    if not api_token:
        raise RuntimeError("OPENROUTER_API_KEY is missing from the environment.")

    model_id = select_openrouter_model()
    app_name = os.getenv("OPENROUTER_APP_NAME", "MindPal")
    referer = os.getenv("OPENROUTER_HTTP_REFERER", "https://github.com/")

    payload = {
        "model": model_id,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.4,
        "top_p": 0.9,
        "max_tokens": 350,
    }

    request = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_token}",
            "Content-Type": "application/json",
            "HTTP-Referer": referer,
            "X-Title": app_name,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            raw_response = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        error_payload = error.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"OpenRouter request failed: {error_payload or error.reason}") from error

    data = json.loads(raw_response)
    choices = data.get("choices") if isinstance(data, dict) else None
    if isinstance(choices, list) and choices:
        message = choices[0].get("message", {}) if isinstance(choices[0], dict) else {}
        content = message.get("content") if isinstance(message, dict) else None
        if content:
            return str(content).strip()

    error_message = data.get("error", {}).get("message") if isinstance(data, dict) else None
    if error_message:
        raise RuntimeError(str(error_message))

    raise RuntimeError("Unexpected response from the OpenRouter API.")


def generate_with_groq(system_prompt: str, user_prompt: str) -> str:
    api_token = os.getenv("GROQ_API_KEY")
    if not api_token:
        raise RuntimeError("GROQ_API_KEY is missing from the environment.")

    model_id = select_groq_model()
    app_name = os.getenv("GROQ_APP_NAME", "MindPal")
    referer = os.getenv("GROQ_HTTP_REFERER", "https://github.com/")

    payload = {
        "model": model_id,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.4,
        "top_p": 0.9,
        "max_tokens": 350,
    }

    request = urllib.request.Request(
        "https://api.groq.com/openai/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_token}",
            "Content-Type": "application/json",
            "HTTP-Referer": referer,
            "X-Title": app_name,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            raw_response = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        error_payload = error.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Groq request failed: {error_payload or error.reason}") from error

    data = json.loads(raw_response)
    choices = data.get("choices") if isinstance(data, dict) else None
    if isinstance(choices, list) and choices:
        message = choices[0].get("message", {}) if isinstance(choices[0], dict) else {}
        content = message.get("content") if isinstance(message, dict) else None
        if content:
            return str(content).strip()

    error_message = data.get("error", {}).get("message") if isinstance(data, dict) else None
    if error_message:
        raise RuntimeError(str(error_message))

    raise RuntimeError("Unexpected response from the Groq API.")


def generate_with_hugging_face(system_prompt: str, user_prompt: str) -> str:
    api_token = os.getenv("HF_API_TOKEN")
    if not api_token:
        raise RuntimeError("HF_API_TOKEN is missing from the environment.")

    model_id = os.getenv("HF_MODEL_ID", "mistralai/Mistral-7B-Instruct-v0.3")
    url = f"https://api-inference.huggingface.co/models/{model_id}"
    payload = {
        "inputs": _build_hf_prompt(system_prompt, user_prompt),
        "parameters": {
            "max_new_tokens": 220,
            "temperature": 0.7,
            "top_p": 0.9,
            "return_full_text": False,
        },
        "options": {
            "wait_for_model": True,
        },
    }

    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            raw_response = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        error_payload = error.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Hugging Face request failed: {error_payload or error.reason}") from error

    data = json.loads(raw_response)
    if isinstance(data, list) and data and isinstance(data[0], dict) and "generated_text" in data[0]:
        return str(data[0]["generated_text"]).strip()

    if isinstance(data, dict) and "generated_text" in data:
        return str(data["generated_text"]).strip()

    if isinstance(data, dict) and "error" in data:
        raise RuntimeError(str(data["error"]))

    raise RuntimeError("Unexpected response from the Hugging Face inference endpoint.")


def log_available_models() -> None:
    providers = [
        ("Google", _list_google_model_ids),
        ("Groq", _list_groq_model_ids),
        ("OpenRouter", _list_openrouter_model_ids),
    ]

    for provider_name, loader in providers:
        try:
            model_ids = loader()
        except Exception as error:
            logger.warning("%s available models could not be listed: %s", provider_name, error)
            continue

        logger.info("%s available models (%d): %s", provider_name, len(model_ids), ", ".join(model_ids))
