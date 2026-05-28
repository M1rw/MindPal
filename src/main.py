from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

import discord
from discord.ext import commands
from dotenv import load_dotenv


BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

load_dotenv(BASE_DIR / ".env")


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
logger = logging.getLogger("mindpal")


intents = discord.Intents.default()
intents.message_content = True


class MindPalBot(commands.Bot):
    async def setup_hook(self) -> None:
        for extension in ("src.cogs.support", "src.cogs.ai_companion", "src.cogs.cognitive_tools"):
            await self.load_extension(extension)


bot = MindPalBot(command_prefix="!", intents=intents)


@bot.tree.command(name="ping", description="Check whether the bot is responsive.")
async def ping(interaction: discord.Interaction) -> None:
    latency_ms = round(bot.latency * 1000)
    await interaction.response.send_message(f"Pong! {latency_ms}ms", ephemeral=True)


@bot.event
async def on_ready() -> None:
    if getattr(bot, "_slash_commands_synced", False):
        return

    try:
        synced_commands = await bot.tree.sync()
    except Exception:
        logger.exception("Failed to sync slash commands.")
        return

    bot._slash_commands_synced = True
    logger.info("Synced %d slash commands.", len(synced_commands))

    if bot.user is not None:
        logger.info("Logged in as %s (%s)", bot.user, bot.user.id)
    else:
        logger.info("Logged in, but bot user is not available yet.")


@bot.event
async def on_app_command_error(interaction: discord.Interaction, error: Exception) -> None:
    logger.error(
        "Unhandled app command error for %s",
        getattr(interaction.command, "qualified_name", "unknown-command"),
        exc_info=(type(error), error, error.__traceback__),
    )

    response = (
        interaction.followup.send
        if interaction.response.is_done()
        else interaction.response.send_message
    )

    try:
        await response("Something went wrong while running that command.", ephemeral=True)
    except Exception:
        logger.exception("Failed to send the app command error response.")


@bot.event
async def on_error(event_method: str, *args: object, **kwargs: object) -> None:
    logger.exception("Unhandled event error in %s", event_method)


def main() -> None:
    token = os.getenv("DISCORD_TOKEN")
    if not token:
        logger.critical("DISCORD_TOKEN is missing. Add it to the .env file.")
        raise SystemExit(1)

    try:
        bot.run(token, log_handler=None)
    except KeyboardInterrupt:
        logger.info("Bot shutdown requested by user.")
    except Exception:
        logger.exception("Bot crashed unexpectedly.")
        raise


if __name__ == "__main__":
    main()