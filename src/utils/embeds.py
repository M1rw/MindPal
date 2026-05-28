from __future__ import annotations

from collections.abc import Iterable

import discord

from src.utils.config import RESOURCE_EMOJIS, RESOURCE_SETS


def _format_link_list(links: Iterable[tuple[str, str]]) -> str:
    return "\n".join(f"🔹 [{label}]({url})" for label, url in links)


def _format_tip_list(tips: Iterable[str]) -> str:
    return "\n".join(f"🔸 {tip}" for tip in tips)


def create_premium_embed(category_key: str) -> discord.Embed:
    resource_set = RESOURCE_SETS[category_key]
    emoji = RESOURCE_EMOJIS.get(category_key, "✨")

    embed = discord.Embed(
        title=f"{emoji} {resource_set['title']}",
        description=resource_set["description"],
        color=discord.Color(resource_set["color"]),
    )

    embed.add_field(name=f"{emoji} Immediate Hotline", value=resource_set["hotline"], inline=False)
    embed.add_field(name="Helpful Links", value=_format_link_list(resource_set["links"]), inline=False)
    embed.add_field(name="Quick Coping Steps", value=_format_tip_list(resource_set["tips"]), inline=False)
    embed.set_footer(text="MindPal Support Tool • Confident & Ephemeral")

    return embed
