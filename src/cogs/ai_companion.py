from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import urllib.error
import urllib.request
from typing import Final

import discord
from discord import app_commands
from discord.ext import commands


logger = logging.getLogger("mindpal.ai_companion")


RESOURCE_SETS: Final[dict[str, dict[str, object]]] = {
    "anxiety": {
        "title": "Anxiety Grounding Resources",
        "color": discord.Color.blurple(),
        "hotline": "SAMHSA National Helpline: 1-800-662-HELP (4357)",
        "links": [
            ("Anxiety Canada", "https://www.anxietycanada.com/"),
            ("NIMH: Anxiety Disorders", "https://www.nimh.nih.gov/health/topics/anxiety-disorders"),
            ("Mind: Anxiety Support", "https://www.mind.org.uk/information-support/types-of-mental-health-problems/anxiety-and-panic-attacks/"),
        ],
        "steps": [
            "Breathe out longer than you breathe in for a few rounds.",
            "Use the 5-4-3-2-1 grounding exercise.",
            "Lower stimulation and stay with a trusted person if you can.",
        ],
    },
    "burnout": {
        "title": "Burnout Recovery Resources",
        "color": discord.Color.gold(),
        "hotline": "SAMHSA National Helpline: 1-800-662-HELP (4357)",
        "links": [
            ("APA: Coping With Burnout", "https://www.apa.org/topics/healthy-workplaces/burnout"),
            ("Mind: Burnout and Work Stress", "https://www.mind.org.uk/workplace/mental-health-at-work/taking-care-of-yourself-at-work/stress-burnout/"),
            ("NHS: Stress Support", "https://www.nhs.uk/mental-health/conditions/stress-anxiety-depression/understanding-stress/"),
        ],
        "steps": [
            "Pause nonessential commitments for today.",
            "Take a real break away from screens and notifications.",
            "Set one small boundary you can keep in the next 24 hours.",
        ],
    },
    "depression": {
        "title": "Depression Support Resources",
        "color": discord.Color.green(),
        "hotline": "988 Suicide & Crisis Lifeline: Call or text 988",
        "links": [
            ("NIMH: Depression", "https://www.nimh.nih.gov/health/topics/depression"),
            ("Mental Health America: Depression", "https://mhanational.org/conditions/depression"),
            ("NHS: Depression Overview", "https://www.nhs.uk/mental-health/conditions/depression-overview/"),
        ],
        "steps": [
            "Keep tasks very small and repeatable.",
            "Use a simple routine even if it feels minimal.",
            "Reach out to a professional if symptoms are getting worse or lasting.",
        ],
    },
    "crisis": {
        "title": "Immediate Crisis Resources",
        "color": discord.Color.red(),
        "hotline": "Emergency services: call local emergency services now. In the U.S. and Canada, call or text 988.",
        "links": [
            ("988 Suicide & Crisis Lifeline", "https://988lifeline.org/"),
            ("Crisis Text Line", "https://www.crisistextline.org/"),
            ("Befrienders Worldwide", "https://www.befrienders.org/"),
        ],
        "steps": [
            "Move away from anything you could use to hurt yourself.",
            "Tell a trusted person you need support right now.",
            "Go to the nearest emergency department if you may act on these thoughts.",
        ],
    },
}


DISTRESS_PATTERNS: Final[dict[str, tuple[str, ...]]] = {
    "crisis": (
        r"\b(suicid(?:e|al)|kill myself|end my life|hurt myself|self[- ]harm|overdose|want to die|don't want to live|can't go on)\b",
    ),
    "panic": (
        r"\b(panic attack|can't breathe|cannot breathe|heart racing|chest tightness|freaking out|i'?m panicking)\b",
    ),
    "burnout": (
        r"\b(burnt? out|burnout|exhausted|overwhelmed|drowning in work|can't keep up|no energy|running on empty)\b",
    ),
    "distress": (
        r"\b(hopeless|worthless|empty|worthless|want to disappear|can't cope|can't take this|deeply sad|numb)\b",
    ),
}


SYSTEM_PROMPT: Final[str] = (
    "You are MindPal, a calm and empathetic coping companion. "
    "Your job is to listen, reflect feelings, and offer supportive grounding suggestions. "
    "Never diagnose, never claim to be a doctor, therapist, or emergency responder, and never give medical or psychiatric instructions. "
    "Do not shame or lecture the user. Keep replies brief, warm, and practical. "
    "If the user mentions self-harm, suicide, wanting to die, or immediate danger, stop the conversation and direct them to crisis resources immediately. "
    "If the user asks for diagnosis, treatment plans, or medication advice, decline gently and suggest a licensed professional."
)


def build_resource_embed(category: str) -> discord.Embed:
    resource_set = RESOURCE_SETS[category]
    embed = discord.Embed(
        title=resource_set["title"],
        description="Here are a few immediate supports you can use right now.",
        color=resource_set["color"],
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


def format_crisis_message() -> discord.Embed:
    return build_resource_embed("crisis")


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

        embed_category = "crisis" if category == "crisis" else category
        embed = build_resource_embed(embed_category)

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
        crisis_category = detect_distress_category(message)
        if crisis_category == "crisis":
            await interaction.response.send_message(
                embed=format_crisis_message(),
                ephemeral=True,
            )
            return

        await interaction.response.defer(thinking=True, ephemeral=True)

        try:
            reply_text = await asyncio.to_thread(self._generate_reply, message)
        except Exception:
            logger.exception("AI chat generation failed.")
            await interaction.followup.send(
                "I couldn't reach the AI service right now. Try again in a moment, or use /resources for immediate support.",
                ephemeral=True,
            )
            return

        if detect_distress_category(reply_text) == "crisis":
            await interaction.followup.send(embed=format_crisis_message(), ephemeral=True)
            return

        embed = discord.Embed(
            title="MindPal Coping Companion",
            description=reply_text[:3500],
            color=discord.Color.blurple(),
        )
        embed.set_footer(text="MindPal is a supportive listener, not a medical professional.")
        await interaction.followup.send(embed=embed, ephemeral=True)

    def _generate_reply(self, user_message: str) -> str:
        api_token = os.getenv("HF_API_TOKEN")
        if not api_token:
            raise RuntimeError("HF_API_TOKEN is missing from the environment.")

        model_id = os.getenv("HF_MODEL_ID", "mistralai/Mistral-7B-Instruct-v0.3")
        url = f"https://api-inference.huggingface.co/models/{model_id}"
        prompt = self._build_prompt(user_message)

        payload = {
            "inputs": prompt,
            "parameters": {
                "max_new_tokens": 220,
                "temperature": 0.7,
                "top_p": 0.9,
                "return_full_text": False,
            },
            "options": {
                "wait_for_model": True,
            },
        }

        request = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {api_token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                raw_response = response.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            error_payload = error.read().decode("utf-8", errors="ignore")
            raise RuntimeError(f"Hugging Face request failed: {error_payload or error.reason}") from error

        data = json.loads(raw_response)
        if isinstance(data, list) and data and isinstance(data[0], dict) and "generated_text" in data[0]:
            return self._sanitize_reply(str(data[0]["generated_text"]))

        if isinstance(data, dict) and "generated_text" in data:
            return self._sanitize_reply(str(data["generated_text"]))

        if isinstance(data, dict) and "error" in data:
            raise RuntimeError(str(data["error"]))

        raise RuntimeError("Unexpected response from the Hugging Face inference endpoint.")

    def _build_prompt(self, user_message: str) -> str:
        return (
            f"System: {SYSTEM_PROMPT}\n\n"
            "Guidance: Respond in 3 to 6 short paragraphs or bullet-like lines. "
            "Use a supportive tone and ask at most one gentle follow-up question.\n\n"
            f"User: {user_message}\n\n"
            "Assistant:"
        )

    def _sanitize_reply(self, reply_text: str) -> str:
        reply = reply_text.strip()
        if not reply:
            raise RuntimeError("The AI service returned an empty response.")
        return reply


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(AICompanion(bot))