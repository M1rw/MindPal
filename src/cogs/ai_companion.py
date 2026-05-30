from __future__ import annotations

import asyncio
import logging
import re
import time
from collections import defaultdict

import discord
from discord import app_commands
from discord.ext import commands

from src.utils.ai_companion_config import DISTRESS_PATTERNS
from src.web.demo_logic import run_chat
from src.utils.ui import generate_resource_ui


logger = logging.getLogger("mindpal.ai_companion")


def build_resource_message(category: str) -> tuple[str, discord.ui.View]:
    # Reuse the shared UI helper to produce markdown content and a view of link buttons
    return generate_resource_ui(category)


class TokenBucket:
    def __init__(self, rate_per_minute: int, capacity: int | None = None) -> None:
        self.rate = rate_per_minute / 60.0
        self.capacity = capacity or rate_per_minute
        self._tokens = float(self.capacity)
        self._last = time.monotonic()
        self._lock = asyncio.Lock()

    async def consume(self, amount: int = 1) -> bool:
        async with self._lock:
            now = time.monotonic()
            elapsed = now - self._last
            self._tokens = min(self.capacity, self._tokens + elapsed * self.rate)
            self._last = now
            if self._tokens >= amount:
                self._tokens -= amount
                return True
            return False


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
        # Bounded queue for outbound resource sends to avoid spikes
        self._job_queue: asyncio.Queue[tuple[int, str, float]] = asyncio.Queue(maxsize=1000)
        # Token bucket to limit global send rate (messages/minute)
        self._bucket = TokenBucket(rate_per_minute=200)
        # Per-user cooldowns (seconds)
        self._user_cooldowns: dict[int, float] = defaultdict(float)
        self._user_cd_seconds = 60
        # Worker tasks
        self._workers: list[asyncio.Task] = []
        for i in range(3):
            task = asyncio.create_task(self._worker_loop(i))
            self._workers.append(task)

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message) -> None:
        if message.author.bot or (self.bot.user is not None and message.author.id == self.bot.user.id):
            return

        category = detect_distress_category(message.content)
        if category is None:
            return

        # Enqueue a resource-send job to be handled by background workers.
        await self._enqueue_resource(message.author.id, category)

    @app_commands.command(name="chat", description="Talk to MindPal's coping companion.")
    @app_commands.describe(message="What would you like to talk about?")
    async def chat(self, interaction: discord.Interaction, message: str) -> None:
        if detect_distress_category(message) == "crisis":
            content, view = build_resource_message("crisis")
            await interaction.response.send_message(content=content, view=view, ephemeral=True)
            return

        await interaction.response.defer(thinking=True, ephemeral=True)

        try:
            reply_text = await asyncio.to_thread(run_chat, message)
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

    async def _enqueue_resource(self, user_id: int, category: str) -> None:
        job = (user_id, category, time.time())
        try:
            self._job_queue.put_nowait(job)
        except asyncio.QueueFull:
            # If queue is full, prefer to keep crisis messages by attempting a blocking put briefly
            if category == "crisis":
                try:
                    await asyncio.wait_for(self._job_queue.put(job), timeout=0.5)
                except Exception:
                    logger.warning("Dropping crisis job because queue is full and put timed out")
            else:
                # drop non-crisis jobs under heavy load
                logger.debug("Dropping non-crisis resource job for user %s due to full queue", user_id)

    async def _worker_loop(self, idx: int) -> None:
        logger.info("AICompanion worker %d starting", idx)
        while True:
            user_id, category, ts = await self._job_queue.get()
            try:
                # per-user cooldown
                last = self._user_cooldowns.get(user_id, 0)
                if time.time() - last < self._user_cd_seconds:
                    logger.debug("Skipping send to %s due to per-user cooldown", user_id)
                    continue

                # global rate limiting
                ok = await self._bucket.consume()
                if not ok:
                    # requeue with a short delay to avoid busy-looping
                    try:
                        await asyncio.sleep(1)
                        await self._job_queue.put((user_id, category, ts))
                    except Exception:
                        logger.warning("Worker %d dropped job due to rate limits and full queue", idx)
                    continue

                # Build message and send via DM (preferred)
                content, view = build_resource_message(category)
                try:
                    user = await self.bot.fetch_user(user_id)
                    await user.send(content=content, view=view)
                    self._user_cooldowns[user_id] = time.time()
                except discord.Forbidden:
                    logger.info("Could not DM user %s with grounding resources.", user_id)
                except Exception:
                    logger.exception("Failed to send distress resources to user %s.", user_id)
            finally:
                try:
                    self._job_queue.task_done()
                except Exception:
                    pass

    async def cog_unload(self) -> None:
        # Cancel workers on unload
        for task in self._workers:
            task.cancel()
        await asyncio.gather(*self._workers, return_exceptions=True)


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(AICompanion(bot))
