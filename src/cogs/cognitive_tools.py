from __future__ import annotations

import asyncio
import logging

import discord
from discord import app_commands
from discord.ext import commands

from src.utils.ai_prompts import CRISIS_TERMS
from src.web.demo_logic import run_realitycheck, run_unscramble


logger = logging.getLogger("mindpal.cognitive_tools")


def _mentions_crisis(text: str) -> bool:
    lowered = text.casefold()
    return any(term in lowered for term in CRISIS_TERMS)


def _trim_response(text: str, limit: int = 3500) -> str:
    return text.strip()[:limit]


def _format_markdown_reply(title: str, body: str, footer: str) -> str:
    return f"**{title}**\n\n{body}\n\n_{footer}_"


class CognitiveTools(commands.Cog):
    def __init__(self, bot: commands.Bot) -> None:
        self.bot = bot

    @app_commands.command(name="unscramble", description="Help untangle messy thoughts in a natural, reflective way.")
    @app_commands.describe(brain_dump="Paste your messy thoughts here.")
    async def unscramble(self, interaction: discord.Interaction, brain_dump: str) -> None:
        await interaction.response.defer(thinking=True, ephemeral=True)

        try:
            if _mentions_crisis(brain_dump):
                result = (
                    "I’m really glad you said that out loud. Right now the priority is your safety, not organizing the thought. "
                    "Please call or text 988 if you’re in the U.S. or Canada, or contact local emergency services immediately. If you can, tell one trusted person and stay with them."
                )
            else:
                result = await asyncio.to_thread(run_unscramble, brain_dump)
        except Exception:
            logger.exception("/unscramble generation failed.")
            await interaction.followup.send(
                "I couldn't reach the AI service right now. Please try again in a moment.",
                ephemeral=True,
            )
            return

        message = _format_markdown_reply(
            "MindPal Unscramble",
            _trim_response(result),
            "MindPal helps you think things through and does not replace professional care.",
        )
        await interaction.followup.send(message, ephemeral=True)

    @app_commands.command(name="realitycheck", description="Gently challenge an anxious thought in a human way.")
    @app_commands.describe(anxious_thought="Paste the anxious thought you want to examine.")
    async def realitycheck(self, interaction: discord.Interaction, anxious_thought: str) -> None:
        await interaction.response.defer(thinking=True, ephemeral=True)

        try:
            if _mentions_crisis(anxious_thought):
                result = (
                    "I’m not going to turn this into a thought exercise because it sounds like you may be in immediate danger. "
                    "Please call or text 988 if you’re in the U.S. or Canada, or contact local emergency services immediately. If you can, tell one trusted person and stay with them."
                )
            else:
                result = await asyncio.to_thread(run_realitycheck, anxious_thought)
        except Exception:
            logger.exception("/realitycheck generation failed.")
            await interaction.followup.send(
                "I couldn't reach the AI service right now. Please try again in a moment.",
                ephemeral=True,
            )
            return

        message = _format_markdown_reply(
            "MindPal Reality Check",
            _trim_response(result),
            "MindPal is supportive, not a substitute for a licensed professional.",
        )
        await interaction.followup.send(message, ephemeral=True)


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(CognitiveTools(bot))
