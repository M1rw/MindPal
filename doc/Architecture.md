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

# LIST

[x] Frontend UX: Clean, minimalist, accessible design (Done).

[x] LLM Integration: Core AI logic and persona constraints (Done).

[x] Memory Management: Sliding window and long-term summarization (Designed).

[ ] Safety Layer: Real-time toxicity/self-harm classification and crisis routing.

[ ] Analytics: Sentiment tracking and LLM observability.

[ ] Async Queues: Background processing for summaries and reports.

[ ] RAG: Grounding responses in verified psychological literature.

[ ] Multi-Modal: Voice integration (STT/TTS).

[ ] Compliance: PII scrubbing and strict data privacy protocols.