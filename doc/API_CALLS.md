# MindPal — API Reference & Integrations

This document outlines all the Application Programming Interfaces (APIs) required to run the full MindPal architecture, including third-party services and the internal backend endpoints you will build.

---

## 1. Third-Party External APIs
These are external services that power MindPal's intelligence, database, and integrations. You will need to generate API keys for each of these and store them securely in your backend's `.env` file.

### Primary AI & Database
* **Google Gemini API (Generative Language API)**
    * **Purpose:** The primary "brain" of MindPal, generating empathetic responses, CBT reframes, and active listening.
    * **Model:** `gemini-2.5-flash` (or preview versions).
    * **Where to get:** [Google AI Studio](https://aistudio.google.com/) -> Get API Key.
    * **Usage in Code:** `backend/services/llm_service.py`

* **Firebase API (Auth & Firestore)**
    * **Purpose:** Securely authenticates users (Anonymous & Custom Tokens) and stores their chat history, profiles, and streaks in the cloud.
    * **Where to get:** [Firebase Console](https://console.firebase.google.com/) -> Project Settings -> Service Accounts (Generate new private key).
    * **Usage in Code:** `frontend/js/auth.js` and `backend/services/db_service.py`

### LLM Fallback Chain (High Availability)
If Gemini experiences downtime, the backend automatically routes requests through these fallback providers to ensure 100% uptime.

* **OpenRouter API (Secondary Fallback)**
    * **Purpose:** Routes to backup models (like Anthropic Claude or Meta Llama 3) if Gemini fails.
    * **Where to get:** [OpenRouter](https://openrouter.ai/) -> Keys.
    * **Usage in Code:** `backend/services/llm_service.py`

* **Groq API (Tertiary Fallback)**
    * **Purpose:** Ultra-low latency fallback using Groq's LPU infrastructure (running models like Llama 3).
    * **Where to get:** [GroqCloud Console](https://console.groq.com/keys).
    * **Usage in Code:** `backend/services/llm_service.py`

* **Hugging Face API (Quaternary Fallback)**
    * **Purpose:** Final fallback for open-source models.
    * **Where to get:** [Hugging Face Settings](https://huggingface.co/settings/tokens).
    * **Usage in Code:** `backend/services/llm_service.py`

### Discord Interface
* **Discord API**
    * **Purpose:** Allows MindPal to run as a bot inside Discord servers, listening to messages and replying in channels.
    * **Where to get:** [Discord Developer Portal](https://discord.com/developers/applications) -> Bot -> Reset Token.
    * **Usage in Code:** `bot/bot_main.py`

---

## 2. Internal Backend API (FastAPI)
Once you migrate the logic to the Python backend, your frontend web app will no longer call Gemini or Firebase directly for heavy operations. Instead, it will call your own internal API.

### `POST /api/chat`
Generates an AI response based on the user's message and current mode.
* **Request Body:**
    ```json
    {
      "user_id": "uid_12345",
      "message": "I feel overwhelmed with work today.",
      "mode": "Cognitive Tools",
      "history": [
        {"role": "User", "text": "Hi"},
        {"role": "MindPal", "text": "Hello, how are you?"}
      ]
    }
    ```
* **Response Body:**
    ```json
    {
      "status": "success",
      "response_text": "**Thought:** You are feeling overwhelmed.\n**Next Tiny Action:** Take a deep breath.",
      "provider_used": "gemini" 
    }
    ```

### `GET /api/user/profile/{user_id}`
Fetches the user's saved data from Firestore via the backend.
* **Response Body:**
    ```json
    {
      "user_id": "uid_12345",
      "user_name": "Friend",
      "streak": 5,
      "total_messages": 42,
      "visit_history": ["Sat Jun 01 2026", "Fri May 31 2026"]
    }
    ```

### `POST /api/user/sync`
Forces a cloud sync of local data if the user just signed in or went back online.
* **Request Body:**
    ```json
    {
      "user_id": "uid_12345",
      "state_data": {
        "chatMemory": [...],
        "streak": 5,
        "crisisMode": true
      }
    }
    ```
* **Response Body:**
    ```json
    {
      "status": "success",
      "message": "Data synchronized to cloud successfully."
    }
    ```
