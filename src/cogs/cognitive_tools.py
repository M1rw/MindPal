from __future__ import annotations

import asyncio
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
        return error.status_code in {401, 403}

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
                try:
                    return _generate_with_hugging_face(system_prompt, user_prompt)
                except Exception as fallback_error:
                    logger.exception("Hugging Face fallback also failed after Gemini access denial.")
                    raise RuntimeError("Gemini access was denied and the fallback model also failed.") from fallback_error

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
        raise RuntimeError("No available Gemini model could generate a response.") from last_error

    raise RuntimeError("No Gemini models are configured.")


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
    await bot.add_cog(CognitiveTools(bot))