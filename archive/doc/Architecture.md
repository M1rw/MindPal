mindpal_project/
│
├── frontend/
│   ├── index.html
│   ├── css/
│   │   └── style.css
│   └── js/
│       ├── app.js
│       ├── auth.js
│       ├── api.js
│       ├── voice.js
│       └── ui_state.js
│
├── backend/
│   ├── main.py
│   ├── core/
│   │   ├── config.py
│   │   ├── security.py
│   │   ├── prompts.py
│   │   ├── logging.py
│   │   └── errors.py
│   │
│   ├── api/
│   │   ├── chat_router.py
│   │   ├── user_router.py
│   │   ├── memory_router.py
│   │   ├── safety_router.py
│   │   └── health_router.py
│   │
│   ├── models/
│   │   ├── schemas.py
│   │   ├── user.py
│   │   ├── chat.py
│   │   ├── safety.py
│   │   └── memory.py
│   │
│   ├── services/
│   │   ├── safety_service.py
│   │   ├── llm_service.py
│   │   ├── rag_service.py
│   │   ├── memory_service.py
│   │   ├── db_service.py
│   │   ├── auth_service.py
│   │   └── tts_service.py
│   │
│   ├── providers/
│   │   ├── gemini_provider.py
│   │   ├── openrouter_provider.py
│   │   ├── groq_provider.py
│   │   ├── perspective_provider.py
│   │   ├── firebase_provider.py
│   │   └── camb_provider.py
│   │
│   ├── safety/
│   │   ├── crisis_patterns_en.yaml
│   │   ├── crisis_patterns_ar.yaml
│   │   ├── crisis_responses.yaml
│   │   ├── prohibited_outputs.yaml
│   │   └── safety_policy.md
│   │
│   ├── rag/
│   │   ├── corpus/
│   │   │   ├── cbt_grounding.yaml
│   │   │   ├── dbt_grounding.yaml
│   │   │   ├── anxiety_grounding.yaml
│   │   │   └── emotion_regulation.yaml
│   │   ├── ingest.py
│   │   ├── retriever.py
│   │   └── citations.py
│   │
│   ├── memory/
│   │   ├── summarizer.py
│   │   ├── compactor.py
│   │   ├── redactor.py
│   │   └── memory_policy.md
│   │
│   ├── tasks/
│   │   ├── background_jobs.py
│   │   └── queue.py
│   │
│   └── tests/
│       ├── test_api_chat.py
│       ├── test_safety.py
│       ├── test_memory.py
│       ├── test_rag.py
│       ├── test_llm_fallback.py
│       └── test_auth.py
│
├── bot/
│   ├── bot_main.py
│   ├── client.py
│   └── cogs/
│       └── chat_cog.py
│
├── data/
│   ├── seed/
│   │   └── demo_users.json
│   └── evals/
│       ├── crisis_cases.jsonl
│       ├── safe_cases.jsonl
│       ├── arabic_cases.jsonl
│       └── jailbreak_cases.jsonl
│
├── docs/
│   ├── ARCHITECTURE.md
│   ├── SAFETY.md
│   ├── MEMORY.md
│   ├── PRIVACY.md
│   ├── RAG.md
│   ├── API.md
│   └── DEPLOYMENT.md
│
├── scripts/
│   ├── run_backend.sh
│   ├── run_frontend.sh
│   ├── run_tests.sh
│   └── ingest_rag.sh
│
├── .env.example
├── .gitignore
├── requirements.txt
├── Dockerfile
├── docker-compose.yml
└── README.md