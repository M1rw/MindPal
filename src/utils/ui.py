from __future__ import annotations

import re
from typing import Tuple

import discord

from src.utils.config import RESOURCE_SETS, RESOURCE_EMOJIS


def _bold_hotline(hotline: str) -> str:
    # Try to bold the phone number/sequence of digits in the hotline string.
    m = re.search(r"(\+?\d[\d\-\s\(\)]+\d)", hotline)
    if m:
        num = m.group(1)
        return hotline.replace(num, f"**{num}**")
    # fallback: bold entire hotline string
    return f"**{hotline}**"


def generate_resource_ui(category_key: str) -> Tuple[str, discord.ui.View]:
    """Generate a markdown content string and a `discord.ui.View` of link buttons for a resource category.

    Args:
        category_key: Key present in `RESOURCE_SETS` (e.g. "anxiety", "depression").

    Returns:
        A tuple of `(content, view)` where `content` is a markdown-formatted string
        and `view` is a `discord.ui.View` containing link buttons for the resource links.
    """
    if category_key not in RESOURCE_SETS:
        content = "**Unknown resource category.** Use the dropdown to pick a valid category."
        return content, discord.ui.View()

    rs = RESOURCE_SETS[category_key]
    emoji = RESOURCE_EMOJIS.get(category_key, "")

    # Title
    title = f"### {emoji} {rs['title']}"

    # Description as blockquote
    description = f"> {rs['description']}"

    # Hotline (bold number if possible)
    hotline = _bold_hotline(rs.get("hotline", ""))
    hotline_line = f"**Hotline:** {hotline}" if hotline else ""

    # Tips as bullet points
    tips_lines = "\n".join(f"- {tip}" for tip in rs.get("tips", ()))

    # Compose content
    parts = [title, "", description, "", hotline_line, "", "**Coping Tips:**", tips_lines]
    content = "\n".join(p for p in parts if p)

    # Build View with link buttons (do not embed links in text)
    view = discord.ui.View(timeout=180)
    for label, url in rs.get("links", ()):  # type: ignore[misc]
        btn = discord.ui.Button(label=label, style=discord.ButtonStyle.link, url=url)
        view.add_item(btn)

    return content, view
