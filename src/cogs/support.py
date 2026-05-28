from __future__ import annotations

import discord
from discord import app_commands
from discord.ext import commands

from src.utils.config import RESOURCE_OPTIONS
from src.utils.ui import generate_resource_ui


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
        content, view = generate_resource_ui(category)
        await interaction.response.edit_message(content=content, view=view)


class ResourceView(discord.ui.View):
    def __init__(self) -> None:
        super().__init__(timeout=180)
        self.add_item(ResourceSelect())


class Support(commands.Cog):
    def __init__(self, bot: commands.Bot) -> None:
        self.bot = bot

    @app_commands.command(name="resources", description="Show mental health support resources.")
    async def resources(self, interaction: discord.Interaction) -> None:
        starter_content = (
            "### MindPal Support Hub\n\n"
            "Use the dropdown below to view a support category tailored to what you need right now.\n\n"
            "**Available Categories:** Anxiety, Depression, Burnout, Crisis\n\n"
            "MindPal Support Tool • Confident & Ephemeral"
        )

        await interaction.response.send_message(content=starter_content, view=ResourceView(), ephemeral=True)


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(Support(bot))