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

**Current demo behavior**
- The web demo mirrors the Discord experience through shared chat logic in `src/web/demo_logic.py`.
- Mode selector supports `Companion`, `Cognitive Tools`, and `Resources`.
- The mode badge and bot avatar color change with the active mode so it is obvious which mode handled the reply.
- The toggle in the demo is now labeled `Concise Mode` and shortens replies when enabled.
- The assistant tries to reply in the same language as the latest user message.

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

**Web Demo (Vercel + Browser UI)**

This repo now includes a deployable web demo so you can showcase MindPal outside Discord.

- API entrypoint: `api/index.py` (FastAPI)
- Web logic (reuses your safety + fallback approach): `src/web/demo_logic.py`
- UI page: `src/assets/demo.html`
- Vercel routing: `vercel.json`

**What works in the web demo**
- Distress classification endpoint and crisis resource rendering
- `/unscramble` and `/realitycheck` powered by your provider fallback chain
- Chat endpoint with crisis short-circuit to immediate resources
- Clean markdown-style UI and link buttons/cards (no embeds)
- Mode-aware bot avatar colors for `Companion`, `Cognitive Tools`, and `Resources`
- `Concise Mode` toggle for shorter replies in the browser demo

**Run locally (web demo)**

```powershell
python -m pip install -r requirements.txt
python -m uvicorn api.index:app --reload --port 8000
```

Open: `http://127.0.0.1:8000`

**Deploy to Vercel**

```powershell
npm i -g vercel
vercel login
vercel
```

Then set your environment variables in Vercel Project Settings (same keys as `.env.example`), for example:
- `GOOGLE_API_KEY`
- `OPENROUTER_API_KEY`
- `GROQ_API_KEY`
- `HF_API_TOKEN`

If no provider key is available at runtime, the app still falls back to local deterministic responses for supported flows.

---
