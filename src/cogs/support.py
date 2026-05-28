from __future__ import annotations

import discord
from discord import app_commands
from discord.ext import commands

from src.utils.config import RESOURCE_OPTIONS
from src.utils.embeds import create_premium_embed


class ResourceSelect(discord.ui.Select):
    def __init__(self) -> None:
        super().__init__(
            placeholder="Choose a support category...",
            min_values=1,
            max_values=1,
            options=[
                discord.SelectOption(label=label, value=value, description=description)
                for label, value, description in RESOURCE_OPTIONS
            ],
        )

    async def callback(self, interaction: discord.Interaction) -> None:
        category = self.values[0]
        await interaction.response.edit_message(embed=create_premium_embed(category), view=self.view)


class ResourceView(discord.ui.View):
    def __init__(self) -> None:
        super().__init__(timeout=180)
        self.add_item(ResourceSelect())


class Support(commands.Cog):
    def __init__(self, bot: commands.Bot) -> None:
        self.bot = bot

    @app_commands.command(name="resources", description="Show mental health support resources.")
    async def resources(self, interaction: discord.Interaction) -> None:
        starter_embed = discord.Embed(
            title="MindPal Support Hub",
            description="Use the dropdown below to view a support category tailored to what you need right now.",
            color=discord.Color.blurple(),
        )
        starter_embed.add_field(
            name="Available Categories",
            value="Anxiety, Depression, Burnout, Crisis",
            inline=False,
        )
        starter_embed.set_footer(text="MindPal Support Tool • Confident & Ephemeral")

        await interaction.response.send_message(embed=starter_embed, view=ResourceView(), ephemeral=True)


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(Support(bot))