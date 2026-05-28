from __future__ import annotations

import asyncio
import logging
import re

import discord
from discord import app_commands
from discord.ext import commands

from src.utils.ai_companion_config import AI_COMPANION_RESOURCE_SETS, DISTRESS_PATTERNS
from src.utils.ai_prompts import AI_COMPANION_SYSTEM_PROMPT
from src.utils.ai_providers import generate_with_hugging_face


logger = logging.getLogger("mindpal.ai_companion")


def build_resource_embed(category: str) -> discord.Embed:
    resource_set = AI_COMPANION_RESOURCE_SETS[category]
    embed = discord.Embed(
        title=resource_set["title"],
        description="Here are a few immediate supports you can use right now.",
        color=discord.Color(resource_set["color"]),
    )
    embed.add_field(name="Hotline", value=resource_set["hotline"], inline=False)
    embed.add_field(
        name="Helpful Links",
        value="\n".join(f"• [{label}]({url})" for label, url in resource_set["links"]),
        inline=False,
    )
    embed.add_field(
        name="Grounding Steps",
        value="\n".join(f"• {step}" for step in resource_set["steps"]),
        inline=False,
    )
    embed.set_footer(text="MindPal is not a substitute for professional care.")
    return embed


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
        await interaction.response.edit_message(embed=build_resource_embed(self.values[0]), view=self.view)


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

        embed = build_resource_embed(category)

        try:
            if message.guild is None:
                await message.channel.send(embed=embed)
            else:
                await message.author.send(embed=embed)
        except discord.Forbidden:
            logger.info("Could not DM %s with grounding resources.", message.author)
        except Exception:
            logger.exception("Failed to send distress resources to %s.", message.author)

    @app_commands.command(name="chat", description="Talk to MindPal's coping companion.")
    @app_commands.describe(message="What would you like to talk about?")
    async def chat(self, interaction: discord.Interaction, message: str) -> None:
        if detect_distress_category(message) == "crisis":
            await interaction.response.send_message(embed=build_resource_embed("crisis"), ephemeral=True)
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

        embed = discord.Embed(title="MindPal Coping Companion", description=reply[:3500], color=discord.Color.blurple())
        embed.set_footer(text="MindPal is a supportive listener, not a medical professional.")
        await interaction.followup.send(embed=embed, ephemeral=True)


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(AICompanion(bot))
