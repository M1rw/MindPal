# Memory — Context & Long-Term Memory Strategy

This doc describes the two-tier memory system used by MindPal and the endpoints that implement it.

What's inside
------------
- Short-term sliding window rules and size recommendations.
- Long-term summarization flow and storage location.
- API endpoints relating to memory and how the backend should inject summaries into prompts.

Key points
----------
- Short-term memory: Pass the last 10–15 turns in the `history` field on `/api/chat`.
- Long-term memory: Store compressed summaries in Firestore under the user's profile and inject into the system prompt.
- Summarization: Run as a background job when local unsummarized logs exceed a threshold (20 messages).

Endpoints
---------
- POST `/api/memory/summarize` (async): Accepts old chat logs and returns an updated compressed summary.
- GET `/api/user/{user_id}/memory`: Return current long-term summary.

Injection pattern
-----------------
Build the system prompt by concatenating the base persona prompt with an optional `[LONG-TERM USER CONTEXT]` block. See `backend/core/prompts.py` for the canonical string and safety redaction rules.
# MindPal — Context & Memory Management Architecture

To prevent "token explosion" (which costs money and causes latency) and "context dilution" (where the AI forgets its system instructions), MindPal uses a **Two-Tiered Memory System**. 

This document explains how the backend manages memory and the API endpoints required to facilitate it.

---

## 1. The Two-Tiered Memory Concept

### Tier 1: Short-Term Memory (The Sliding Window)
* **What it is:** The AI only "sees" the most recent 10 to 15 interactions (turns) of the conversation.
* **Why:** It keeps the AI focused on the user's immediate emotional state and drastically reduces API costs.
* **Where it lives:** Passed dynamically in the `history` array during the `POST /api/chat` request.

### Tier 2: Long-Term Memory (AI Summarization)
* **What it is:** A compressed, running summary of the user's psychological state, past traumas, triggers, and major life events discussed in older messages.
* **Why:** So the AI remembers that the user's dog died 3 weeks ago without needing to read the entire 3-week chat log.
* **Where it lives:** Stored in the Firestore Database under the user's profile and injected dynamically into the **System Prompt** at the start of every request.

---

## 2. The API Endpoints (FastAPI Backend)

When you build your Python backend, these are the API calls that will handle this memory system.

### A. The Core Chat Endpoint (Updated for Memory)
When the frontend sends a message, it only sends the *sliding window* of history. The backend is responsible for fetching the Long-Term Memory from Firestore and injecting it.

* **Endpoint:** `POST /api/chat`
* **Request Body (From Frontend):**
    ```json
    {
      "user_id": "uid_12345",
      "message": "I'm feeling that same anxiety again today.",
      "mode": "Active Listen",
      "history": [
        {"role": "User", "text": "I can't sleep."},
        {"role": "MindPal", "text": "I'm here. Insomnia is so draining."}
      ] // ONLY the last 10 messages!
    }
    ```

### B. Trigger Background Summarization
You do not want the user to wait for the AI to summarize their history while they are chatting. This should be an asynchronous background task. 
*Trigger this when a user's local history exceeds 20 messages, or when they close the app.*

* **Endpoint:** `POST /api/memory/summarize`
* **Request Body:**
    ```json
    {
      "user_id": "uid_12345",
      "unsummarized_chat_logs": [
        {"role": "User", "text": "My boss yelled at me today."},
        {"role": "MindPal", "text": "That sounds incredibly stressful."},
        // ... 15 to 20 older messages ...
      ]
    }
    ```
* **What the Backend Does:**
    1. Calls Gemini with a specialized prompt: *"Read this chat log and extract core psychological context, triggers, and life events. Merge it with the user's existing summary."*
    2. Saves the new compressed summary to Firestore.
* **Response Body:**
    ```json
    {
      "status": "success",
      "message": "Long-term memory updated in background."
    }
    ```

### C. Fetch User Context (App Boot)
When the user opens the app, the frontend can fetch their current psychological summary just to have it, or let the backend handle it entirely.

* **Endpoint:** `GET /api/user/{user_id}/memory`
* **Response Body:**
    ```json
    {
      "user_id": "uid_12345",
      "long_term_summary": "User struggles with workplace anxiety and imposter syndrome. Responds well to grounding exercises. Recently had a conflict with their manager."
    }
    ```

---

## 3. How the Backend Injects Long-Term Memory

Inside your Python backend (`llm_service.py`), before sending the request to Gemini, the code will dynamically build the System Prompt like this:

```python
def build_system_prompt(base_prompt: str, user_summary: str) -> str:
    # If the user has no history, just return the base prompt
    if not user_summary:
        return base_prompt
        
    # Inject the long-term memory safely
    memory_injection = f"""
    [LONG-TERM USER CONTEXT]
    The following is a psychological summary of your past conversations with this user. 
    Use this to inform your empathy, but do not aggressively bring it up unless relevant.
    Summary: {user_summary}
    [/LONG-TERM USER CONTEXT]
    """
    
    return base_prompt + "\n\n" + memory_injection
```

## 4. The Complete Lifecycle

1. **User Types:** "I'm having that issue with my boss again."
2. **Frontend Sends:** Sends *only* that message + the last 5 messages to `POST /api/chat`.
3. **Backend Database Read:** Backend pulls the Long-Term Summary from Firestore (*"User has a toxic boss named Sarah"*).
4. **Backend LLM Call:** Backend combines the System Prompt + Summary + Short-term history and sends to Gemini.
5. **Backend Responds:** Gemini replies, Backend forwards response to UI.
6. **Background Task:** Every 20 messages, the Frontend hits `POST /api/memory/summarize` and the Backend compresses the old messages into a newly updated Firestore summary, keeping the token count permanently low.