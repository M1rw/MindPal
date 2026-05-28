from __future__ import annotations

from typing import Final

import discord
from discord import app_commands
from discord.ext import commands


RESOURCE_SETS: Final[dict[str, dict[str, object]]] = {
    "anxiety": {
        "title": "Anxiety Support Resources",
        "description": "Grounding tools, coping ideas, and immediate support options.",
        "color": discord.Color.blurple(),
        "hotline": "SAMHSA National Helpline: 1-800-662-HELP (4357)",
        "links": [
            ("Anxiety Canada - Self Help", "https://www.anxietycanada.com/"),
            ("NIMH - Anxiety Disorders", "https://www.nimh.nih.gov/health/topics/anxiety-disorders"),
            ("Mind - Anxiety Resources", "https://www.mind.org.uk/information-support/types-of-mental-health-problems/anxiety-and-panic-attacks/"),
        ],
        "tips": [
            "Try the 5-4-3-2-1 grounding exercise.",
            "Lower stimulation and breathe out longer than you breathe in.",
            "Reach out to someone safe and stay with them if possible.",
        ],
    },
    "depression": {
        "title": "Depression Support Resources",
        "description": "Supportive information, self-check resources, and crisis contacts.",
        "color": discord.Color.green(),
        "hotline": "988 Suicide & Crisis Lifeline: Call or text 988",
        "links": [
            ("NIMH - Depression", "https://www.nimh.nih.gov/health/topics/depression"),
            ("Mental Health America - Depression", "https://mhanational.org/conditions/depression"),
            ("NHS - Depression Overview", "https://www.nhs.uk/mental-health/conditions/depression-overview/"),
        ],
        "tips": [
            "Keep tasks small and repeatable.",
            "Use a simple daily routine, even if it is minimal.",
            "Contact a professional if symptoms are worsening or lasting.",
        ],
    },
    "crisis": {
        "title": "Immediate Crisis Support",
        "description": "If you may be in danger, use these emergency resources now.",
        "color": discord.Color.red(),
        "hotline": "Emergency: call local emergency services now. In the U.S. and Canada, call or text 988.",
        "links": [
            ("988 Suicide & Crisis Lifeline", "https://988lifeline.org/"),
            ("Crisis Text Line", "https://www.crisistextline.org/"),
            ("Befrienders Worldwide", "https://www.befrienders.org/"),
        ],
        "tips": [
            "Move away from anything you could use to hurt yourself.",
            "Contact a trusted person and tell them you need support right now.",
            "Go to the nearest emergency department if you are at immediate risk.",
        ],
    },
}


class Support(commands.Cog):
    def __init__(self, bot: commands.Bot) -> None:
        self.bot = bot

    @app_commands.command(name="resources", description="Show mental health support resources.")
    @app_commands.describe(category="Optional category: anxiety, depression, or crisis.")
    async def resources(
        self,
        interaction: discord.Interaction,
        category: str | None = None,
    ) -> None:
        selected_category = (category or "crisis").strip().lower()
        resource_set = RESOURCE_SETS.get(selected_category)

        if resource_set is None:
            valid_categories = ", ".join(sorted(RESOURCE_SETS))
            await interaction.response.send_message(
                f"Unknown category `{category}`. Try one of: {valid_categories}.",
                ephemeral=True,
            )
            return

        embed = discord.Embed(
            title=resource_set["title"],
            description=resource_set["description"],
            color=resource_set["color"],
        )

        embed.add_field(name="Immediate Hotline", value=resource_set["hotline"], inline=False)

        links = "\n".join(
            f"• [{label}]({url})" for label, url in resource_set["links"]
        )
        embed.add_field(name="Helpful Links", value=links, inline=False)

        tips = "\n".join(f"• {tip}" for tip in resource_set["tips"])
        embed.add_field(name="Quick Coping Steps", value=tips, inline=False)

        embed.set_footer(text="MindPal support resources are informational and not a substitute for professional care.")

        await interaction.response.send_message(embed=embed, ephemeral=True)


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(Support(bot))