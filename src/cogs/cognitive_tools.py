from __future__ import annotations

import asyncio
from functools import lru_cache
import json
import logging
import os
import urllib.error
import urllib.request
from typing import Final

import discord
from discord import app_commands
from discord.ext import commands
from google.genai import errors as genai_errors

try:
    from google import genai
    from google.genai import types
except ImportError as exc:  # pragma: no cover - import-time dependency guard
    genai = None
    types = None
    _IMPORT_ERROR = exc
else:
    _IMPORT_ERROR = None


logger = logging.getLogger("mindpal.cognitive_tools")


UNSCRAMBLE_PROMPT: Final[str] = (
    "You are a brain-fog translator for overwhelmed individuals. DO NOT give medical advice. "
    "DO NOT give long lists. Take the user's chaotic input and output strictly three things: "
    "1. Things in their control. 2. Things out of their control. 3. One microscopic, low-effort next step."
)

REALITYCHECK_PROMPT: Final[str] = (
    "You are a CBT-inspired cognitive mirror. The user is spiraling. DO NOT just agree with them. "
    "Gently and respectfully challenge their cognitive distortion. Ask one thought-provoking question to help them reframe their anxiety."
)

CRISIS_TERMS: Final[tuple[str, ...]] = (
    "suicide",
    "suicidal",
    "kill myself",
    "end my life",
    "hurt myself",
    "self-harm",
    "self harm",
    "overdose",
    "don't want to live",
    "do not want to live",
    "want to die",
)


def _ensure_genai_available() -> None:
    if genai is None:
        raise RuntimeError(
            "google-genai is not installed. Install it with: python -m pip install google-genai"
        ) from _IMPORT_ERROR


def _build_client() -> object:
    _ensure_genai_available()

    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        raise RuntimeError("GOOGLE_API_KEY is missing from the environment.")

    return genai.Client(api_key=api_key)


def _build_hf_prompt(system_prompt: str, user_prompt: str) -> str:
    return (
        f"System: {system_prompt}\n\n"
        f"User: {user_prompt}\n\n"
        "Assistant:"
    )

def _normalize_model_id(model_id: str) -> str:
    return model_id.removeprefix("models/").strip()

def _pick_preferred_model(active_models: tuple[str, ...], preferred_models: list[str]) -> str:
    active_lookup = { _normalize_model_id(model_id): model_id for model_id in active_models }

    for preferred_model in preferred_models:
        normalized = _normalize_model_id(preferred_model)
        if normalized and normalized in active_lookup:
            return active_lookup[normalized]

    return active_models[0]


def _mentions_crisis(text: str) -> bool:
    lowered = text.casefold()
    return any(term in lowered for term in CRISIS_TERMS)


def _offline_unscramble_response(user_prompt: str) -> str:
    if _mentions_crisis(user_prompt):
        return (
            "Things in your control:\n"
            "- Move away from anything you could use to hurt yourself.\n"
            "- Contact one trusted person now and tell them you need support.\n\n"
            "Things out of your control:\n"
            "- How quickly the feeling passes.\n"
            "- Everything you have already been through.\n\n"
            "One microscopic next step:\n"
            "- Call or text 988 now, or go to the nearest emergency department."
        )

    lowered = user_prompt.casefold()
    control_items = [
        "What you do next.",
        "Who you contact for support.",
        "Whether you take one tiny step instead of solving everything at once.",
    ]

    if any(word in lowered for word in ("work", "job", "boss", "deadline")):
        control_items[0] = "How you break the next task into something small."
    elif any(word in lowered for word in ("school", "class", "exam", "study")):
        control_items[0] = "Which assignment or topic you focus on first."
    elif any(word in lowered for word in ("relationship", "partner", "friend", "family")):
        control_items[0] = "How you phrase one honest message or boundary."

    return (
        "Things in your control:\n"
        + "\n".join(f"- {item}" for item in control_items)
        + "\n\nThings out of your control:\n"
        + "- Other people's reactions.\n"
        + "- The entire problem all at once.\n"
        + "- The fact that your brain is overwhelmed right now.\n\n"
        "One microscopic next step:\n"
        "- Put one sentence from the brain dump into a note titled \"next\"."
    )


def _offline_realitycheck_response(user_prompt: str) -> str:
    if _mentions_crisis(user_prompt):
        return (
            "I’m not going to mirror this as a thought exercise because it sounds like you may be in immediate danger.\n\n"
            "What matters right now is getting live support: call or text 988 if you’re in the U.S. or Canada, or contact local emergency services immediately. If you can, tell one trusted person and stay with them until support is connected."
        )

    lowered = user_prompt.casefold()
    if any(word in lowered for word in ("always", "never", "ruining", "everyone", "nobody", "disaster", "fail")):
        challenge = "That thought sounds absolute, but is it really 100% true, or is your mind filling in the worst-case version?"
    else:
        challenge = "What evidence would you have to see before you’d treat this thought as a fact instead of a fear?"

    return (
        f"{challenge}\n\n"
        "One question:\n"
        "- If your best friend had the same thought, what would you tell them to check first?"
    )


def _offline_response(system_prompt: str, user_prompt: str) -> str:
    if "brain-fog translator" in system_prompt.casefold():
        return _offline_unscramble_response(user_prompt)

    if "cognitive mirror" in system_prompt.casefold():
        return _offline_realitycheck_response(user_prompt)

    return "I couldn’t reach the AI service, but I’m still here. Try again in a moment."


def _generate_with_hugging_face(system_prompt: str, user_prompt: str) -> str:
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

def _select_google_model() -> str:
    active_models = _list_google_model_ids()
    configured_model = os.getenv("GEMINI_MODEL", "").strip()
    preferred_models = [configured_model, "gemini-2.5-flash", "gemini-2.0-flash"]
    return _pick_preferred_model(active_models, preferred_models)


def _generate_with_openrouter(system_prompt: str, user_prompt: str) -> str:
    api_token = os.getenv("OPENROUTER_API_KEY")
    if not api_token:
        raise RuntimeError("OPENROUTER_API_KEY is missing from the environment.")

    model_id = _select_openrouter_model()
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

def _select_openrouter_model() -> str:
    active_models = _list_openrouter_model_ids()
    configured_model = os.getenv("OPENROUTER_MODEL", "").strip()
    preferred_models = [
        configured_model,
        "openai/gpt-4o-mini",
        "openai/gpt-4o",
        "anthropic/claude-3.5-sonnet",
        "meta-llama/llama-3.3-70b-instruct",
    ]
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
                model_ids.append(model_id)

    if not model_ids:
        raise RuntimeError("Groq models API returned no active models.")

    return tuple(model_ids)


def _select_groq_model() -> str:
    active_models = _list_groq_model_ids()
    configured_model = os.getenv("GROQ_MODEL", "").strip()
    preferred_models = [
        configured_model,
        "llama-3.1-8b-instant",
        "llama-3.3-70b-versatile",
        "llama-3.1-70b-versatile",
        "meta-llama/llama-4-scout-17b-16e-instruct",
        "meta-llama/llama-4-maverick-17b-128e-instruct",
    ]

    for model_id in preferred_models:
        if model_id and model_id in active_models:
            return model_id

    return active_models[0]


def _generate_with_groq(system_prompt: str, user_prompt: str) -> str:
    api_token = os.getenv("GROQ_API_KEY")
    if not api_token:
        raise RuntimeError("GROQ_API_KEY is missing from the environment.")

    model_id = _select_groq_model()
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


def _try_remote_fallbacks(system_prompt: str, user_prompt: str) -> str:
    try:
        return _generate_with_openrouter(system_prompt, user_prompt)
    except Exception as openrouter_error:
        logger.warning("OpenRouter fallback failed: %s", openrouter_error)

    try:
        return _generate_with_groq(system_prompt, user_prompt)
    except Exception as groq_error:
        logger.warning("Groq fallback failed: %s", groq_error)

    try:
        return _generate_with_hugging_face(system_prompt, user_prompt)
    except Exception as hugging_face_error:
        logger.warning("Hugging Face fallback failed: %s", hugging_face_error)

    return _offline_response(system_prompt, user_prompt)


def _log_available_models() -> None:
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


def _model_candidates() -> list[str]:
    configured_model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash").strip()
    fallback_models = ["gemini-2.5-flash", "gemini-2.0-flash"]

    candidates: list[str] = []
    for model_name in [configured_model, *fallback_models]:
        if model_name and model_name not in candidates:
            candidates.append(model_name)

    return candidates


def _is_access_denied(error: Exception) -> bool:
    if isinstance(error, genai_errors.ClientError):
        code = getattr(error, "code", None)
        status = getattr(error, "status", None)
        message = str(error).casefold()
        return code in {401, 403} or status in {"PERMISSION_DENIED", "UNAUTHENTICATED"} or "permission_denied" in message

    message = str(error).casefold()
    return "permission_denied" in message or "denied access" in message or "403" in message


def _generate_text(system_prompt: str, user_prompt: str) -> str:
    client = _build_client()
    last_error: Exception | None = None

    for model_name in _model_candidates():
        try:
            response = client.models.generate_content(
                model=model_name,
                contents=f"System prompt:\n{system_prompt}\n\nUser input:\n{user_prompt}",
                config=types.GenerateContentConfig(
                    temperature=0.4,
                    top_p=0.9,
                    max_output_tokens=350,
                ),
            )
        except (genai_errors.ClientError,) as error:
            if _is_access_denied(error):
                logger.warning("Gemini access denied for model %s; falling back to Hugging Face.", model_name)
                return _try_remote_fallbacks(system_prompt, user_prompt)

            logger.warning("Gemini model %s failed: %s", model_name, error)
            last_error = error
            continue

        except Exception as error:
            logger.warning("Gemini model %s is unavailable: %s", model_name, error)
            last_error = error
            continue

        text = getattr(response, "text", None)
        if not text:
            raise RuntimeError("The Gemini API returned an empty response.")

        return str(text).strip()

    if last_error is not None:
        logger.warning("No Gemini model could generate a response; trying Hugging Face, then OpenRouter, then offline fallback.")
        return _try_remote_fallbacks(system_prompt, user_prompt)

    logger.warning("No Gemini models are configured; using offline fallback.")
    return _try_remote_fallbacks(system_prompt, user_prompt)


def _trim_response(text: str, limit: int = 3500) -> str:
    cleaned = text.strip()
    return cleaned[:limit]


class CognitiveTools(commands.Cog):
    def __init__(self, bot: commands.Bot) -> None:
        self.bot = bot

    @app_commands.command(name="unscramble", description="Turn a brain dump into three clear buckets.")
    @app_commands.describe(brain_dump="Paste your messy thoughts here.")
    async def unscramble(self, interaction: discord.Interaction, brain_dump: str) -> None:
        await interaction.response.defer(thinking=True, ephemeral=True)

        try:
            result = await asyncio.to_thread(_generate_text, UNSCRAMBLE_PROMPT, brain_dump)
        except Exception:
            logger.exception("/unscramble generation failed.")
            await interaction.followup.send(
                "I couldn't reach the AI service right now. Please try again in a moment.",
                ephemeral=True,
            )
            return

        embed = discord.Embed(
            title="MindPal Unscramble",
            description=_trim_response(result),
            color=discord.Color.blurple(),
        )
        embed.set_footer(text="MindPal is designed to help organize thoughts, not replace professional care.")
        await interaction.followup.send(embed=embed, ephemeral=True)

    @app_commands.command(name="realitycheck", description="Gently challenge an anxious thought.")
    @app_commands.describe(anxious_thought="Paste the anxious thought you want to examine.")
    async def realitycheck(self, interaction: discord.Interaction, anxious_thought: str) -> None:
        await interaction.response.defer(thinking=True, ephemeral=True)

        try:
            result = await asyncio.to_thread(_generate_text, REALITYCHECK_PROMPT, anxious_thought)
        except Exception:
            logger.exception("/realitycheck generation failed.")
            await interaction.followup.send(
                "I couldn't reach the AI service right now. Please try again in a moment.",
                ephemeral=True,
            )
            return

        embed = discord.Embed(
            title="MindPal Reality Check",
            description=_trim_response(result),
            color=discord.Color.teal(),
        )
        embed.set_footer(text="MindPal is supportive, not a substitute for a licensed professional.")
        await interaction.followup.send(embed=embed, ephemeral=True)


async def setup(bot: commands.Bot) -> None:
    _log_available_models()
    await bot.add_cog(CognitiveTools(bot))