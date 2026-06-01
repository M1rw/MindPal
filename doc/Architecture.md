mindpal_project/
│
├── frontend/                     # The Web Interface
│   ├── index.html
│   ├── js/
│   │   ├── app.js                
│   │   └── auth.js               
│   └── css/
│       └── style.css
│
├── backend/                      # The API & Brain (FastAPI)
│   ├── main.py                   
│   ├── core/
│   │   ├── config.py             
│   │   ├── security.py           
│   │   └── prompts.py            
│   ├── api/
│   │   ├── chat_router.py        
│   │   ├── user_router.py        
│   │   └── memory_router.py      # [NEW] POST /api/memory/summarize endpoint
│   ├── services/
│   │   ├── llm_service.py        
│   │   ├── db_service.py         
│   │   ├── safety_service.py     # [NEW] The "Crisis Funnel" & Perspective API checks
│   │   ├── memory_service.py     # [NEW] Context window & LLM summarization logic
│   │   └── rag_service.py        # [NEW] Vector DB (Pinecone/Qdrant) clinical retrieval
│   ├── tasks/
│   │   └── background_jobs.py    # [NEW] Async queue for heavy lifting (summaries, emails)
│   └── models/
│       └── schemas.py            
│
├── bot/                          # The Discord Interface
│   ├── bot_main.py               
│   └── cogs/                     
│       └── chat_cog.py           
│
├── data/                         # [NEW] Clinical Knowledge Base
│   └── clinical_frameworks/      # [NEW] Raw CBT/DBT texts and PDFs to feed your RAG
│
├── tests/                        # Production Testing
│   ├── test_api.py               
│   ├── test_llm.py               
│   └── test_safety.py            # [NEW] Tests to ensure the Crisis Funnel triggers correctly
│
├── .env                          
├── .gitignore                    
├── requirements.txt              
├── Dockerfile                    
└── README.md

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