from __future__ import annotations

import asyncio
import logging
import os
from typing import Final

import discord
from discord import app_commands
from discord.ext import commands

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


def _generate_text(system_prompt: str, user_prompt: str) -> str:
    client = _build_client()
    model_name = os.getenv("GEMINI_MODEL", "gemini-1.5-flash")
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
        raise RuntimeError("The Gemini API returned an empty response.")

    return str(text).strip()


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