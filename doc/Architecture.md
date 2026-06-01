mindpal_project/
│
├── frontend/                     # The Web Interface
│   ├── index.html
│   ├── js/
│   │   ├── app.js                # UI logic and API calls
│   │   └── auth.js               # Firebase client login logic
│   └── css/
│       └── style.css
│
├── backend/                      # The API & Brain (FastAPI)
│   ├── main.py                   # FastAPI application entry point
│   ├── core/
│   │   ├── config.py             # Loads API keys and environment variables securely
│   │   ├── security.py           # Handles CORS and token validation
│   │   └── prompts.py            # Stores system instructions (CBT, Active Listen)
│   ├── api/
│   │   ├── chat_router.py        # POST /api/chat endpoint
│   │   └── user_router.py        # GET /api/user/profile endpoint
│   ├── services/
│   │   ├── llm_service.py        # The Fallback Chain (Gemini -> OpenRouter -> Groq)
│   │   └── db_service.py         # Firebase Admin setup and Firestore read/writes
│   └── models/
│       └── schemas.py            # Pydantic data models (Validates incoming/outgoing JSON)
│
├── bot/                          # The Discord Interface
│   ├── bot_main.py               # Initializes the Discord bot
│   └── cogs/                     # Discord commands and event listeners
│       └── chat_cog.py           # Listens to messages and forwards them to services/llm_service.py
│
├── tests/                        # Production Testing
│   ├── test_api.py               # Tests to make sure endpoints work
│   └── test_llm.py               # Tests to make sure the AI fallbacks trigger correctly
│
├── .env                          # ALL SECRETS (Do not upload to GitHub!)
├── .gitignore                    # Tells Git to ignore .env and __pycache__
├── requirements.txt              # Python dependencies
├── Dockerfile                    # Instructions to package the app for a server
└── README.md                     # Setup instructions for your team

API Calls
---------
Frontend -> Backend (JSON over HTTPS):

1) POST /api/chat
Purpose: Send a user message and receive a model response.
Request body:
- session_id: string (client-generated)
- user_id: string | null (from auth, optional)
- mode: string ("Active Listen" | "Guided Coach" | "Cognitive Tools")
- message: string
- history: array of { role: "user" | "assistant", content: string } (optional, last N)
- client_meta: { locale?: string, tz?: string, app_version?: string }
Response body:
- reply: string
- safety: { crisis_flag: boolean, reason?: string }
- tokens: { prompt: int, completion: int, total: int }
- model: { provider: string, name: string }
- session_id: string
Errors: 400 (validation), 401 (auth), 429 (rate limit), 500

2) GET /api/user/profile
Purpose: Fetch profile settings for signed-in users.
Response body:
- user_id: string
- display_name: string
- preferences: { theme?: "light" | "dark", crisis_mode?: boolean }
- stats: { messages: int, active_days: int }
Errors: 401 (auth), 404 (not found)

3) POST /api/user/profile
Purpose: Update user profile settings.
Request body:
- display_name?: string
- preferences?: { theme?: "light" | "dark", crisis_mode?: boolean }
Response body:
- ok: boolean

Prompts
-------
All prompts are stored in backend/core/prompts.py. The API composes a base system prompt and then appends a mode-specific prompt.

Base system prompt (always used):
- Role: empathetic wellness companion.
- Tone: concise, warm, non-judgmental.
- Safety: encourage seeking professional help when needed; never claim to be a clinician.
- Output: avoid heavy markdown; keep to plain text.

Mode prompts:
- Active Listen: Validate in 1-2 sentences. Do not give advice.
- Guided Coach: Validate briefly, then give exactly one small action step.
- Cognitive Tools (CBT): Use a fixed structure with labeled sections:
	Thought, Distortion, Evidence For, Evidence Against, Balanced Reframe, Next Tiny Action.

Safety prompts (applied when crisis is detected):
- Short, direct, supportive language.
- Provide local emergency resources (configured by locale), and ask if the user is safe.
- No moralizing or threats.

How It Works
------------
1) Client sends /api/chat with message, mode, and limited history.
2) Backend runs safety scan (keyword + model-based flagging later).
3) If crisis_flag = true, return a crisis response without calling LLMs.
4) Otherwise select prompt by mode, then call llm_service fallback chain:
	 Gemini -> OpenRouter -> Groq.
5) Response is returned to client and optionally persisted by db_service.

Notes
-----
- History window should be capped to last N turns (e.g., 12) to control cost.
- PII should be redacted from logs; avoid storing raw content in analytics.