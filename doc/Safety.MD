# MindPal — Advanced Safety & Moderation Architecture

To achieve a "Top 1" status in the mental health AI space, safety cannot be an afterthought. Relying solely on the LLM to "behave" is a massive liability. The system must act defensively, detecting and mitigating crisis situations *before* they reach the core generation engine.

This document outlines the **4-Tiered Crisis Funnel** and the technical implementation required for MindPal's FastAPI backend.

---

## 1. The 4-Tiered Moderation Funnel

MindPal uses a "Defense in Depth" strategy to ensure user safety and clinical boundaries.

### Tier 1: Client-Side Triage (Heuristic/Regex)
* **What it is:** The lightweight keyword checker currently running in your frontend JavaScript.
* **Purpose:** Instant, offline interception of highly explicit crisis keywords (`suicide`, `kill myself`, `end it all`).
* **Benefit:** Zero latency. Immediately provides the user with emergency hotlines without waiting for a server round-trip.

### Tier 2: Server-Side Pre-LLM Semantic Moderation
* **What it is:** Before calling Gemini, the FastAPI backend sends the user's message to a dedicated, high-speed classification API (e.g., **OpenAI Moderation API**, **Google Perspective API**, or a local distilled BERT model).
* **Purpose:** Catches nuanced, implied self-harm, severe toxicity, or abuse that simple keyword filters miss (e.g., *"I just don't see a reason to wake up tomorrow"*).
* **Action:** If flagged for self-harm, the backend **aborts** the LLM call and triggers the deterministic Crisis Protocol (Tier 3).

### Tier 3: The Deterministic Crisis Protocol (The "Bypass")
* **What it is:** A hardcoded, culturally-aware intervention flow.
* **Purpose:** AI is prone to hallucination; in a life-or-death crisis, we cannot rely on probabilistic text generation.
* **Action:** If Tier 1 or Tier 2 flags the user, the backend returns a localized, static response containing emergency numbers, locks the chat context temporarily so the AI doesn't try to "continue" the conversation, and logs the event.

### Tier 4: Post-LLM Output Validation
* **What it is:** A final safety check on the *AI's* response before sending it back to the user.
* **Purpose:** Ensures the AI didn't hallucinate dangerous advice, violate the "no medical diagnosis" rule, or output broken Markdown.

---

## 2. Technical Implementation (FastAPI)

### A. Moderation Pydantic Models (`models/schemas.py`)
Define strict data structures to handle moderation flags.

```python
from pydantic import BaseModel
from typing import List, Optional

class ModerationResult(BaseModel):
    is_flagged: bool
    categories: List[str]  # e.g., ["self-harm", "violence"]
    confidence_score: float

class ChatRequest(BaseModel):
    user_id: str
    message: str
    mode: str
    language_locale: str = "en-US" # Used to fetch the correct crisis hotlines
```

### B. The Safety Service (`services/safety_service.py`)
This service acts as the gatekeeper. It calls an external Moderation API (like OpenAI's free `text-moderation-latest` endpoint) to scan the text.

```python
import httpx

async def check_semantic_safety(message: str) -> ModerationResult:
    # Example using a dedicated Moderation API
    url = "https://api.openai.com/v1/moderations"
    headers = {"Authorization": f"Bearer {MODERATION_API_KEY}"}
    payload = {"input": message}
    
    async with httpx.AsyncClient() as client:
        response = await client.post(url, json=payload, headers=headers)
        data = response.json()
        
        results = data["results"][0]
        is_flagged = results["flagged"]
        
        # Specifically check for self-harm intent
        if results["categories"]["self-harm"] or results["categories"]["self-harm/intent"]:
            return ModerationResult(
                is_flagged=True, 
                categories=["self-harm"], 
                confidence_score=results["category_scores"]["self-harm"]
            )
            
        return ModerationResult(is_flagged=is_flagged, categories=[], confidence_score=0.0)
```

### C. The Crisis Resource Mapper (`core/crisis_resources.py`)
If a crisis is detected, you must serve localized hotlines based on the user's dialect/location, rather than giving a generic US number to someone in Egypt.

```python
CRISIS_HOTLINES = {
    "en-US": {
        "text": "It sounds like you are going through an incredibly dark time. Please know you are not alone. Please text HOME to 741741 or call 988.",
        "phone": "988"
    },
    "ar-EG": {
        "text": "يبدو أنك تمر بوقت مظلم وصعب جداً. أرجوك تذكر أنك لست وحدك وهناك من يمكنه المساعدة. يرجى الاتصال بالأمانة العامة للصحة النفسية في مصر على 08008880700 أو 0220816831.",
        "phone": "08008880700"
    },
    "ar-SA": {
        "text": "يبدو أنك تمر بفترة صعبة جداً. لست وحدك في هذا. نرجو منك التواصل مع مركز اتصال الاستشارات النفسية (تطبيق قريبون) على الرقم 920033360.",
        "phone": "920033360"
    }
}

def get_crisis_response(locale: str) -> str:
    return CRISIS_HOTLINES.get(locale, CRISIS_HOTLINES["en-US"])["text"]
```

### D. The Chat Router (`api/chat_router.py`)
This is where the funnel comes together. Notice how the LLM is entirely bypassed if the safety check fails.

```python
from fastapi import APIRouter, HTTPException
from services.safety_service import check_semantic_safety
from core.crisis_resources import get_crisis_response
from services.llm_service import generate_gemini_response

router = APIRouter()

@router.post("/api/chat")
async def handle_chat(request: ChatRequest):
    # Tier 2: Pre-LLM Semantic Moderation
    safety_check = await check_semantic_safety(request.message)
    
    if safety_check.is_flagged and "self-harm" in safety_check.categories:
        # LOGGING: Trigger alert to Human-In-The-Loop (HITL) database here
        # ... db.log_crisis_event(request.user_id, request.message) ...
        
        # Bypassing the LLM completely for deterministic safety
        crisis_message = get_crisis_response(request.language_locale)
        return {
            "status": "crisis_intercepted",
            "response_text": crisis_message,
            "action": "pause_session"
        }
        
    # If safe, proceed to Tier 3: LLM Generation
    ai_response = await generate_gemini_response(request.message, request.mode)
    
    # Return standard response
    return {
        "status": "success",
        "response_text": ai_response
    }
```

---

## 3. Human-in-the-Loop (HITL) Auditing
A production mental health app requires oversight. You must build an internal dashboard (or simply a specific Firestore collection) that captures flagged events.

### Data Logged During a Crisis Event:
* `timestamp`: Exact time of the flag.
* `user_id`: Anonymized ID to track repeat escalations.
* `trigger_message`: The user's input that triggered the flag.
* `confidence_score`: How certain the model was (used to tune sensitivity).
* `action_taken`: E.g., "Served Egypt Hotline".

**Why this matters:** Tracking false positives (the model flagging someone talking about a "killer workout") versus true positives allows you to fine-tune your moderation thresholds over time, ensuring the app remains both highly protective and highly usable.
