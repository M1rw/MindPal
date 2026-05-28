from __future__ import annotations

import asyncio
import logging
import re

import discord
from discord import app_commands
from discord.ext import commands

from src.utils.ai_companion_config import DISTRESS_PATTERNS
from src.utils.ai_prompts import AI_COMPANION_SYSTEM_PROMPT
from src.utils.ai_providers import generate_with_hugging_face
from src.utils.ui import generate_resource_ui


logger = logging.getLogger("mindpal.ai_companion")


def build_resource_message(category: str) -> tuple[str, discord.ui.View]:
    # Reuse the shared UI helper to produce markdown content and a view of link buttons
    return generate_resource_ui(category)


def detect_distress_category(content: str) -> str | None:
    normalized = content.casefold()
    for category, patterns in DISTRESS_PATTERNS.items():
        for pattern in patterns:
            if re.search(pattern, normalized, re.IGNORECASE):
                return category
    return None


class ResourceSelect(discord.ui.Select):
    def __init__(self) -> None:
        options = [
            discord.SelectOption(label="Anxiety", value="anxiety", description="Grounding and calming resources"),
            discord.SelectOption(label="Depression", value="depression", description="Support and daily coping tools"),
            discord.SelectOption(label="Burnout", value="burnout", description="Recovery, rest, and boundaries"),
            discord.SelectOption(label="Crisis", value="crisis", description="Immediate safety and crisis support"),
        ]
        super().__init__(placeholder="Choose a support category...", min_values=1, max_values=1, options=options)

    async def callback(self, interaction: discord.Interaction) -> None:
        content, view = build_resource_message(self.values[0])
        await interaction.response.edit_message(content=content, view=view)


class ResourceView(discord.ui.View):
    def __init__(self) -> None:
        super().__init__(timeout=180)
        self.add_item(ResourceSelect())


class AICompanion(commands.Cog):
    def __init__(self, bot: commands.Bot) -> None:
        self.bot = bot

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message) -> None:
        if message.author.bot or (self.bot.user is not None and message.author.id == self.bot.user.id):
            return

        category = detect_distress_category(message.content)
        if category is None:
            return

        content, view = build_resource_message(category)

        try:
            if message.guild is None:
                await message.channel.send(content=content, view=view)
            else:
                await message.author.send(content=content, view=view)
        except discord.Forbidden:
            logger.info("Could not DM %s with grounding resources.", message.author)
        except Exception:
            logger.exception("Failed to send distress resources to %s.", message.author)

    @app_commands.command(name="chat", description="Talk to MindPal's coping companion.")
    @app_commands.describe(message="What would you like to talk about?")
    async def chat(self, interaction: discord.Interaction, message: str) -> None:
        if detect_distress_category(message) == "crisis":
            content, view = build_resource_message("crisis")
            await interaction.response.send_message(content=content, view=view, ephemeral=True)
            return

        await interaction.response.defer(thinking=True, ephemeral=True)

        try:
            reply_text = await asyncio.to_thread(generate_with_hugging_face, AI_COMPANION_SYSTEM_PROMPT, message)
        except Exception:
            logger.exception("AI chat generation failed.")
            await interaction.followup.send(
                "I couldn't reach the AI service right now. Try again in a moment, or use /resources for immediate support.",
                ephemeral=True,
            )
            return

        reply = reply_text.strip()
        if not reply:
            await interaction.followup.send(
                "I couldn't generate a response right now. Please try again in a moment.",
                ephemeral=True,
            )
            return

        # Send plain markdown reply (ephemeral) with a short footer line appended.
        reply_md = f"**MindPal Coping Companion**\n\n{reply[:3500]}\n\n_MindPal is a supportive listener, not a medical professional._"
        await interaction.followup.send(reply_md, ephemeral=True)


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(AICompanion(bot))
