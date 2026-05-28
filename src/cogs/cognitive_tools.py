from __future__ import annotations

import asyncio
import logging

import discord
from discord import app_commands
from discord.ext import commands

from src.utils.ai_prompts import CRISIS_TERMS, REALITYCHECK_PROMPT, UNSCRAMBLE_PROMPT
from src.utils.ai_providers import (
    generate_with_google,
    generate_with_groq,
    generate_with_hugging_face,
    generate_with_openrouter,
    log_available_models,
)


logger = logging.getLogger("mindpal.cognitive_tools")


def _mentions_crisis(text: str) -> bool:
    lowered = text.casefold()
    return any(term in lowered for term in CRISIS_TERMS)


def _offline_unscramble_response(user_prompt: str) -> str:
    if _mentions_crisis(user_prompt):
        return (
            "Things in your control:\n"
            "- Move away from anything you could use to hurt yourself.\n"
            "- Contact one trusted person now and tell them you need support.\n\n"
            "Things out of your control:\n"
            "- How quickly the feeling passes.\n"
            "- Everything you have already been through.\n\n"
            "One microscopic next step:\n"
            "- Call or text 988 now, or go to the nearest emergency department."
        )

    lowered = user_prompt.casefold()
    control_items = [
        "What you do next.",
        "Who you contact for support.",
        "Whether you take one tiny step instead of solving everything at once.",
    ]

    if any(word in lowered for word in ("work", "job", "boss", "deadline")):
        control_items[0] = "How you break the next task into something small."
    elif any(word in lowered for word in ("school", "class", "exam", "study")):
        control_items[0] = "Which assignment or topic you focus on first."
    elif any(word in lowered for word in ("relationship", "partner", "friend", "family")):
        control_items[0] = "How you phrase one honest message or boundary."

    return (
        "Things in your control:\n"
        + "\n".join(f"- {item}" for item in control_items)
        + "\n\nThings out of your control:\n"
        + "- Other people's reactions.\n"
        + "- The entire problem all at once.\n"
        + "- The fact that your brain is overwhelmed right now.\n\n"
        "One microscopic next step:\n"
        "- Put one sentence from the brain dump into a note titled \"next\"."
    )


def _offline_realitycheck_response(user_prompt: str) -> str:
    if _mentions_crisis(user_prompt):
        return (
            "I’m not going to mirror this as a thought exercise because it sounds like you may be in immediate danger.\n\n"
            "What matters right now is getting live support: call or text 988 if you’re in the U.S. or Canada, or contact local emergency services immediately. If you can, tell one trusted person and stay with them until support is connected."
        )

    lowered = user_prompt.casefold()
    if any(word in lowered for word in ("always", "never", "ruining", "everyone", "nobody", "disaster", "fail")):
        challenge = "That thought sounds absolute, but is it really 100% true, or is your mind filling in the worst-case version?"
    else:
        challenge = "What evidence would you have to see before you’d treat this thought as a fact instead of a fear?"

    return (
        f"{challenge}\n\n"
        "One question:\n"
        "- If your best friend had the same thought, what would you tell them to check first?"
    )


def _offline_response(system_prompt: str, user_prompt: str) -> str:
    if "brain-fog translator" in system_prompt.casefold():
        return _offline_unscramble_response(user_prompt)

    if "cognitive mirror" in system_prompt.casefold():
        return _offline_realitycheck_response(user_prompt)

    return "I couldn’t reach the AI service, but I’m still here. Try again in a moment."


def _try_remote_fallbacks(system_prompt: str, user_prompt: str) -> str:
    for provider_name, provider in (
        ("OpenRouter", generate_with_openrouter),
        ("Groq", generate_with_groq),
        ("Hugging Face", generate_with_hugging_face),
    ):
        try:
            return provider(system_prompt, user_prompt)
        except Exception as error:
            logger.warning("%s fallback failed: %s", provider_name, error)

    return _offline_response(system_prompt, user_prompt)


def _generate_text(system_prompt: str, user_prompt: str) -> str:
    try:
        return generate_with_google(system_prompt, user_prompt)
    except Exception as error:
        logger.warning("Google generation failed: %s", error)
        return _try_remote_fallbacks(system_prompt, user_prompt)


def _trim_response(text: str, limit: int = 3500) -> str:
    return text.strip()[:limit]


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
    log_available_models()
    await bot.add_cog(CognitiveTools(bot))
