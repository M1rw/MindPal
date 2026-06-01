# MindPal — Project Development Task Tracker

This document serves as the master checklist and roadmap for the MindPal project. It tracks our progress across the Frontend (Face), Backend (Brain), and specialized architectural components (Memory, Safety, RAG).

---

## 🟢 Phase 1: Foundation & Frontend UI (Completed)

- [x] **UI/UX Design:** Build a clean, minimalist, Gemini-inspired HTML interface.
- [x] **Theme Management:** Implement Dark/Light mode toggle.
- [x] **Therapeutic Modes:** Create dropdown for "Active Listen," "Guided Coach," and "Cognitive Tools."
- [x] **Gamification (V1):** Implement Weekly Journey/Streak tracker with visual feedback (flame icon, checkmarks).
- [x] **Firebase Integration (Client-Side):** Set up basic Auth and Firestore sync for profiles and chat history.
- [x] **Basic LLM Connection:** Connect to Gemini API directly from JS (Temporary for prototyping).
- [x] **CBT Parsing:** Write regex/JS logic to parse the strict Markdown `**Thought:**` format into an interactive UI accordion.
- [x] **UX Polish:** Add typing indicators, smooth scrolling, and typing animations.

---

## 🟡 Phase 2: Backend Architecture & API Migration (In Progress)

*Goal: Move all heavy lifting, API keys, and business logic from the frontend JavaScript to a secure FastAPI Python backend.*

### 1. Core Setup
- [x] **`core/config.py`:** Create robust settings management using Pydantic (handling API keys gracefully).
- [x] **`models/schemas.py`:** Define strict JSON validation models (`ChatRequest`, `ChatResponse`, `MessageTurn`).
- [x] **`main.py`:** Initialize FastAPI app, configure CORS, and set up global exception handling.
- [ ] **`.env` Configuration:** Set up local environment variables for Gemini, OpenRouter, and Groq.

### 2. LLM & Prompt Services
- [x] **Advanced Prompts:** Design robust, "Anti-Robot," polyglot system prompts for all modes.
- [ ] **`services/llm_service.py`:** Build the multi-provider fallback chain (Gemini $\rightarrow$ OpenRouter $\rightarrow$ Groq).
- [ ] **`api/chat_router.py`:** Create the `POST /api/chat` endpoint to receive frontend requests and return AI responses.

### 3. Frontend Refactor
- [ ] **Strip `mindpal.js`:** Remove the direct Gemini API call (`callGemini`) from the frontend.
- [ ] **Connect Frontend to Backend:** Update `handleSend()` in JS to `fetch()` from `http://localhost:8000/api/chat`.

---

## 🔴 Phase 3: Advanced Architectures (Pending)

*Goal: Implement the "Top 1" features that make MindPal clinically safe, highly retentive, and clinically grounded.*

### 1. The "Crisis Funnel" (Safety)
- [ ] **`services/safety_service.py`:** Integrate Google Perspective API or Hugging Face classifiers for pre-LLM toxicity/self-harm checks.
- [ ] **Crisis Routing:** Update `chat_router.py` to bypass the LLM and return static emergency resources if distress is detected.
- [ ] **Frontend Lock:** Update UI to disable input and display the "Crisis Mode" screen when triggered.

### 2. Context & Memory Management
- [ ] **Sliding Window:** Implement logic in `chat_router.py` to only send the last 10 messages to the LLM.
- [ ] **`services/memory_service.py`:** Build the logic to summarize 20+ past messages into a compressed "Psychological Summary."
- [ ] **`api/memory_router.py`:** Create `POST /api/memory/summarize` to trigger this process.
- [ ] **`tasks/background_jobs.py`:** Move summarization to an async background queue so it doesn't block the user chat.

### 3. Clinical Grounding (RAG)
- [ ] **Data Ingestion:** Gather verified CBT/DBT/ACT worksheets and grounding exercises (`data/clinical_frameworks/`).
- [ ] **Vector Database:** Set up Pinecone or Qdrant locally/cloud.
- [ ] **`services/rag_service.py`:** Write the embedding and semantic search pipeline (using LangChain or LlamaIndex).
- [ ] **Prompt Injection:** Update the LLM service to inject retrieved clinical techniques into the system prompt.

### 4. Database & Persistence (Backend Shift)
- [ ] **`services/db_service.py`:** Set up Firebase Admin SDK in Python.
- [ ] **Move Writes to Backend:** Refactor so the backend (not the frontend) saves the chat logs and updates streaks securely to Firestore.

---

## 🟣 Phase 4: Multi-Modal & Expansion (Future)

- [ ] **Native Voice Input:** Integrate the Web Speech API (`SpeechRecognition`) in the frontend for voice-to-text.
- [ ] **Voice Output:** Add TTS (`SpeechSynthesis`) so MindPal can audibly guide breathing exercises.
- [ ] **Discord Integration:** Build `bot_main.py` and connect it to the shared `llm_service.py` and `safety_service.py`.
- [ ] **Analytics Dashboard:** Build a simple admin view to track usage, sentiment trends, and crisis triggers.
- [ ] **Production Deployment:** Dockerize the backend and deploy to Render/Railway; deploy frontend to Vercel.
