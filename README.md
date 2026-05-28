# MindPal — Minimal Mental Health Companion (Python)

MindPal is a lightweight, extensible Discord bot written in modern Python (3.12+) and discord.py. It provides safe, privacy-minded mental-health support utilities (resource lookups, brief cognitive tools) and an optional AI-backed coping companion. The project favors component-driven Markdown UIs (buttons and Views) over embeds and is designed to be run in a single process or scaled later using a job queue.

This README covers quick setup, configuration, running locally, and development notes.

**Quick Links**
- **Code:** repository root
- **Main entrypoint:** `src/main.py`
- **Cogs:** `src/cogs/` (`support`, `ai_companion`, `cognitive_tools`)
- **Shared utils:** `src/utils/` (`config.py`, `ui.py`, `ai_*`)

---

**Requirements**
- Python 3.12+ (3.13 tested)
- A virtual environment (recommended)
- Discord bot token with appropriate Gateway intents (see `ENABLE_MESSAGE_CONTENT_INTENT` below)

**Core design goals**
- Privacy-forward: ephemeral responses for sensitive flows; DMs used when appropriate.
- Component-driven Markdown UI: no `discord.Embed` usage — buttons and markdown-first presentation.
- Safe AI usage: strict system prompts, multi-provider fallbacks, and deterministic offline fallbacks for resilience.
- Rate-limited outbound sends: bounded queue, token-bucket global limiter, per-user cooldowns to prevent overload.

---

**Quickstart (Windows PowerShell)**

1. Create and activate a virtual environment (Python 3.12+):

```powershell
python -m venv .venv
. .venv\Scripts\Activate.ps1
```

2. Install dependencies:

```powershell
python -m pip install -r requirements.txt
```

3. Create a `.env` file from `.env.example` and set the values (see Configuration below):

```powershell
copy .env.example .env
# Edit .env and add your DISCORD_TOKEN and any AI provider keys
```

4. Run the bot:

```powershell
python src/main.py
```

The bot will load cogs from `src/cogs` and sync application commands on startup.

---

**Configuration (important env vars)**
- `DISCORD_TOKEN` — your bot token (required)
- `ENABLE_MESSAGE_CONTENT_INTENT` — `true|false` to enable `message_content` intent (only set if your bot has the privileged intent)
- AI providers (optional): `HF_API_TOKEN`, `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY` — set only those you plan to use
- `HF_MODEL_ID`, `OPENROUTER_MODEL`, `GROQ_MODEL`, `GEMINI_MODEL` — optional preferred model IDs

See `.env.example` for a full list of supported environment variables.

---

**How the bot handles sensitive language**
- Local distress detection uses conservative regex patterns (`src/utils/ai_companion_config.py`) to detect categories: `crisis`, `anxiety`, `depression`, `burnout`.
- For crisis-level content (e.g., phrases indicating self-harm), the bot bypasses AI replies and sends immediate safety resources.
- Outbound resource sends are processed by a bounded background queue with:
	- a token-bucket global rate limit (default 200 sends/minute),
	- per-user cooldown (default 60s),
	- bounded queue (default maxsize 1000) and worker tasks.

These defaults are tuned to avoid being overwhelmed in noisy servers. You can tune them in the AI companion cog or move them to `src/utils/config.py` for central configuration.

---

**Developer notes**
- UI modernization: resource displays use `src/utils/ui.py::generate_resource_ui(category_key)` which returns a markdown string and a `discord.ui.View` with link buttons. Avoid adding new `discord.Embed` calls.
- AI providers: the project uses a fallback chain (Gemini → OpenRouter → Groq → Hugging Face → deterministic offline fallback). See `src/utils/ai_providers.py`.
- Tests and tools:
	- `tools/test_distress.py` — quick local tests for distress regexes.
	- `tools/import_check.py` — smoke import-check for modules.

---

**Testing**
- Run the distress-pattern tests:

```powershell
python tools/test_distress.py
```

- Run the import smoke-test:

```powershell
python tools/import_check.py
```

---
