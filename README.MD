Replace your README with this:

````markdown
# MindPal — AI Support That Remembers What Matters

MindPal is a private AI companion for reflection, emotional clarity, voice journaling, structured memory, grounded coping tools, and context-aware support.

It started as a simple Discord bot idea.

The original concept was small:

```txt
A Discord bot
  -> mental health resources
  -> cognitive tools
  -> optional AI companion
  -> safe fallback replies
  -> markdown-first UI
````

That idea evolved into a full web application with a real product architecture:

```txt
MindPal
  -> browser chat interface
  -> voice input
  -> Firebase authentication
  -> local mode
  -> cloud mode
  -> chat sync
  -> structured memory
  -> semantic intake
  -> response modes
  -> clinical framework RAG
  -> safety routing
  -> output guard
  -> provider fallback chain
  -> production deployment on Vercel
```

MindPal is not another chatbot.

It is a thinking space.

A voice journal.

A memory layer.

A structured support system for moments when the user is overwhelmed, overthinking, angry, anxious, stuck, or emotionally unclear.

---

## Tagline

```txt
AI support that remembers what matters.
```

---

## Product Vision

Most AI companions fail because they treat every user message the same.

They read the latest sentence.
They respond with generic support.
They forget context.
They miss the real emotional pattern.
They ask soft questions when the user needs direction.
They give advice when the user needs grounding.
They over-explain when the user is panicking.
They hallucinate facts about the current chat.
They do not remember what matters.

MindPal was built around a different idea:

```txt
The AI should understand the meaning behind the message before answering.
```

The user should not need to explain themselves from zero every time.

MindPal combines:

```txt
semantic intake
+ safety routing
+ memory
+ response modes
+ clinical framework RAG
+ deterministic product context
+ cloud/local sync
```

The goal is not to make the AI sound emotional.

The goal is to make the AI respond correctly.

---

## What MindPal Does

MindPal supports users through text, voice, memory, and structured thinking.

It can:

* listen through typed messages
* listen through browser voice input
* convert voice into chat text
* understand the user’s actual situation
* remember durable personal details
* sync chat and memory across devices when signed in
* stay local-only when used without an account
* answer from actual conversation history
* route responses through different support modes
* retrieve grounded coping frameworks
* detect safety-sensitive situations before LLM generation
* produce structured Cognitive Tools responses
* support Egyptian Arabic and English
* preserve privacy boundaries between local and cloud modes

---

## From Discord Bot to MindPal Web App

The original README described MindPal as a Discord bot written in Python using `discord.py`.

That project had useful foundations:

```txt
privacy-minded support
safe AI fallback
cognitive tools
resource lookup
markdown-first UI
rate-limited sends
deterministic crisis handling
```

But the Discord bot model had limitations.

### Why the Discord bot was not enough

Discord is good for lightweight commands, but MindPal needed to become more personal.

The product needed:

```txt
private chat history
persistent memory
voice input
better UI control
cloud sync
local-only mode
auth
structured response rendering
clinical framework retrieval
browser-first user experience
```

Discord components also limited the emotional feel of the product.

A support companion should not feel like a bot command.

It should feel like a private space.

So the project was rebuilt into a web app.

---

## Current MindPal Architecture

```txt
MindPal/
  backend/
    api/
      chat_router.py
      chat_store_router.py
      health_router.py
      memory_router.py
      safety_router.py
      tts_router.py

    core/
      prompts.py
      config.py
      security.py
      errors.py

    models/
      chat.py
      memory.py
      safety.py
      user.py

    services/
      llm_service.py
      rag_service.py
      memory_service.py
      safety_service.py
      db_service.py

    rag/
      corpus/

  frontend/
    index.html
    js/
      app.js
      api.js
      auth.js
      ui_state.js
      voice.js
      voice_languages.js
      memory_engine.js
    assets/
      brand/

  data/
    clinical_frameworks/

  docs/
    architecture/
    backend/
    frontend/
    ops/
    product/
    rag/
    testing/
    workflows/

  tests/
```

---

## System Overview

MindPal has five main runtime systems.

```txt
Frontend
  browser UI
  localStorage state
  Firebase Auth client
  voice input
  memory inspector
  chat rendering
  cloud chat sync client

Backend
  FastAPI routes
  request context
  safety service
  semantic intake
  RAG service
  LLM provider chain
  memory compaction
  Firestore/local DB boundary

AI Layer
  Cloudflare Workers AI / AI Gateway
  provider fallback support
  mode-aware prompts
  semantic intake context
  clinical framework grounding
  output guard

Storage
  guest mode: localStorage
  cloud mode: Firestore-backed chat and memory

RAG / Clinical Frameworks
  curated YAML corpus
  safe coping frameworks
  grounding techniques
  relationship safety
  cognitive tools
```

---

## Request Flow

When the user sends a message, MindPal does not just call an LLM.

The full flow is:

```txt
User sends message
  -> frontend appends user message locally
  -> frontend sends current message + chat history + metadata
  -> backend resolves auth/session/locale
  -> safety classifier checks input
  -> deterministic crisis bypass if needed
  -> deterministic chat-context answer if applicable
  -> load profile and memory if authenticated
  -> build semantic intake
  -> infer response mode
  -> retrieve RAG grounding
  -> build system prompt
  -> call LLM provider chain
  -> output guard validates final text
  -> compact memory if useful
  -> return response
  -> frontend renders response
  -> frontend syncs assistant message to cloud if signed in
```

This is the core product loop.

---

## Semantic Intake

Semantic intake is the layer that makes MindPal understand the actual meaning of a message before generating an answer.

Without semantic intake, an AI may respond to one random phrase inside the user’s message.

With semantic intake, MindPal extracts the real situation.

Example:

```txt
User:
"My husband criticizes me constantly. After 20 years I feel worthless. He says he loves me, but I do not feel it. Should I continue?"

Semantic intake:
  language_style: egyptian_arabic
  situation_type: relationship_distress
  core_problem: long-term criticism, invalidation, emotional exhaustion
  user_need: validation, safety/support check, practical next step
  risk_flags: possible_emotional_invalidation
  avoid:
    - diagnosing spouse
    - generic identity question
    - fake reassurance
  answer_strategy:
    validate, avoid diagnosis, ask one safety/support question, give one practical next step
```

This prevents bad responses like:

```txt
"How can you know your identity better?"
```

when the user is actually describing long-term emotional harm.

---

## Response Modes

MindPal has user-facing modes.

These are listening preferences, not rigid response locks.

```txt
Active Listen
  when the user needs to feel heard

Guided Coach
  when the user needs direction or wording

Cognitive Tools
  when the user needs structured thinking
```

The backend still has permission to override the selected mode when safety or intent requires it.

Example:

```txt
Selected mode: Active Listen
User message: "I'm panicking and can't breathe"
Actual backend mode: panic_grounding

Selected mode: Cognitive Tools
User message: "He won't let me leave"
Actual backend mode: personal_safety
```

The UI gives the user control.

The backend protects correctness.

---

## Cognitive Tools

Cognitive Tools is for thought separation.

It helps the user identify:

```txt
thought
distortion
evidence for
evidence against
balanced reframe
next tiny action
```

Example:

```txt
Thought:
If I don't fix everything today, I'm a failure.

Distortion:
All-or-nothing thinking.

Evidence For:
I feel overwhelmed and I do have a lot to do.

Evidence Against:
Not finishing everything today does not erase previous progress.

Balanced Reframe:
I can be behind and still be moving. Today only needs progress, not perfection.

Next Tiny Action:
Pick one task and work on it for 10 minutes.
```

The frontend renders Cognitive Tools as:

```txt
Accordion:
  Thought
  Distortion
  Evidence For
  Evidence Against
  Done

Visible answer:
  Balanced Reframe
  Next Action
```

This keeps the analysis available without overwhelming the user.

---

## Voice Input

MindPal includes browser-based voice input.

The voice system is intentionally written as a state machine.

```txt
idle
confirming_language
preparing_mic
listening
stopping
review
no_speech
heard_no_transcript
network_error
permission_error
device_error
generic_error
unsupported
```

Rules:

```txt
- no hidden auto-retry loops
- retry is manual
- cancel always stops the mic
- accept inserts the transcript into the input
- waveform is visual only
- waveform volume is not treated as proof of speech
- mobile browsers use safer non-continuous speech recognition
```

This was one of the hardest systems in the app.

The initial voice implementation had hidden restart loops, no-speech bugs, and browser-specific behavior. It was rebuilt into a cleaner phase-based system.

---

## Memory v2

MindPal memory is structured.

It does not store every chat message as memory.

It stores durable user facts and preferences.

Examples:

```txt
preferred_name = Marwan
important_people = مي / Mi / Maya
communication_style = direct
language_preference = Egyptian Arabic when user writes Egyptian Arabic
known_patterns = relationship overthinking, study pressure
avoided_responses = generic reassurance
```

Memory is separate from raw chat.

```txt
Raw chat history
  complete conversation messages

Memory
  durable facts and preferences

RAG
  curated grounding frameworks
```

This separation is important.

Without it, memory becomes noisy and unsafe.

---

## Memory Inspector

MindPal includes a Memory Inspector in the UI.

It allows the user to view, edit, and delete what MindPal remembers.

Example visible memory rows:

```txt
Preferred Name:
  Marwan

Important Person:
  مي / Mi / Maya

Communication:
  direct answers, avoid generic motivation
```

This makes memory transparent instead of hidden.

---

## Local Mode vs Cloud Mode

MindPal supports two privacy models.

### Guest / Local Mode

```txt
chat history -> localStorage
memory -> localStorage
auth -> none
sync -> none
```

Local mode is browser-only.

If the user clears browser storage, local data is gone.

### Cloud Mode

```txt
auth -> Firebase Auth
chat sync -> Firestore via backend routes
memory -> Firestore-backed structured summary
localStorage -> cache/fallback
```

Cloud mode allows the user to continue across devices.

---

## Cloud Chat Sync

Cloud chat sync uses backend routes:

```txt
GET    /api/chats/current
PUT    /api/chats/current
POST   /api/chats/current/messages
DELETE /api/chats/current
```

Expected flow:

```txt
on login:
  load cloud chat
  merge with local unsynced messages
  render merged chat

on user message:
  save locally immediately
  sync to cloud if signed in

on assistant reply:
  save locally immediately
  sync to cloud if signed in

on clear chat:
  clear local cache
  delete cloud current chat if signed in
```

Chat sync is not memory.

Memory is compact and durable.

Chat sync is raw conversation persistence.

---

## Deterministic Chat Context

MindPal does not let the LLM guess product facts.

For example:

```txt
"How many messages were sent in this chat?"
```

The backend answers deterministically from `payload.history`.

The model should not guess the count.

The same principle applies to:

```txt
- current chat message count
- previous message
- known profile name
- stored memory facts
```

If the system can know it, the LLM should not hallucinate it.

---

## Clinical Framework RAG

MindPal has a curated grounding corpus.

The RAG service loads from:

```txt
backend/rag/corpus
data/clinical_frameworks
```

Frameworks include:

```txt
panic grounding
5-4-3-2-1 grounding
DBT STOP
cognitive reframe
anger delay
study triage
relationship boundary
relationship safety
```

The RAG layer is not for diagnosis.

It is for practical guidance.

It helps the assistant avoid random wellness advice and use safer, clearer techniques.

Example RAG health endpoint:

```txt
GET /api/rag/health
```

Expected response includes:

```json
{
  "loaded_units": 58,
  "failed_files": [],
  "tags": [
    "panic_grounding",
    "grounding_54321",
    "dbt_stop",
    "cognitive_reframe",
    "relationship_distress"
  ]
}
```

---

## Safety System

MindPal runs safety before generation.

Safety flow:

```txt
input message
  -> safety classifier
  -> deterministic bypass if crisis
  -> safe response rendering
  -> safety event persistence if needed
```

Important rule:

```txt
High-risk safety responses should not depend on LLM improvisation.
```

MindPal uses deterministic safety responses for crisis-level cases.

---

## Output Guard

After the LLM generates a response, MindPal runs output validation.

This helps catch unsafe or unsuitable generated text before returning it to the user.

Flow:

```txt
LLM response
  -> output guard
  -> rewrite if needed
  -> final reply
```

---

## LLM Provider Chain

MindPal supports provider fallback.

The intended provider architecture:

```txt
Cloudflare Workers AI / AI Gateway
OpenRouter
Groq
Gemini
deterministic fallback
```

Provider order is controlled by environment variables.

Example:

```txt
LLM_PROVIDER_ORDER=cloudflare,openrouter,groq
```

This keeps the app resilient.

If one provider fails, MindPal can try the next provider instead of breaking.

---

## Frontend Structure

```txt
frontend/index.html
  main browser UI

frontend/js/app.js
  app bootstrap
  chat flow
  memory inspector
  cloud chat sync orchestration
  message rendering
  Cognitive Tools rendering

frontend/js/api.js
  backend request client
  chat payload normalization
  auth token transport
  memory/cloud chat API calls

frontend/js/auth.js
  Firebase auth client

frontend/js/ui_state.js
  local state
  chat memory
  streaks
  UI utilities

frontend/js/voice.js
  voice input state machine

frontend/js/voice_languages.js
  voice language options and fallbacks

frontend/js/memory_engine.js
  local memory classification
  memory conversion
  memory inspector rows
```

---

## Backend Structure

```txt
backend/api/chat_router.py
  main chat route
  safety
  semantic intake
  RAG retrieval
  LLM request
  memory compaction

backend/api/chat_store_router.py
  cloud chat sync routes

backend/api/memory_router.py
  cloud memory routes

backend/api/health_router.py
  health checks
  RAG health

backend/core/prompts.py
  system prompts
  response modes
  semantic intake
  RAG tag vocabulary

backend/services/llm_service.py
  provider chain
  trace generation

backend/services/rag_service.py
  YAML corpus loading
  retrieval scoring
  grounding references

backend/services/memory_service.py
  memory compaction
  structured memory extraction

backend/services/safety_service.py
  safety classification
  deterministic safety responses

backend/services/db_service.py
  database boundary
```

---

## GitHub Copilot Development Workflow

MindPal was built through a Copilot-assisted engineering workflow.

The project moved fast because Copilot was used as a senior implementation partner, not just autocomplete.

### 1. Turning the Discord bot idea into a web product

Copilot helped convert the original bot concept into a browser-first product.

The architectural jump was:

```txt
Discord commands
  -> FastAPI backend
  -> browser UI
  -> auth
  -> cloud sync
  -> local fallback
  -> memory
  -> voice
  -> RAG
  -> safety pipeline
```

This turned the project from a bot into a full application.

### 2. Backend architecture

Copilot helped design and implement:

```txt
chat route lifecycle
request context
safety-first pipeline
semantic intake
response mode routing
memory compaction
RAG retrieval
provider fallback
output guard
cloud chat routes
RAG health route
```

The backend was built around clear boundaries:

```txt
chat != memory != RAG != safety != provider
```

That separation made the system easier to debug.

### 3. Frontend architecture

Copilot helped create the browser experience:

```txt
chat rendering
local state
profile modal
memory inspector
mode selector
mood buttons
voice input
Cognitive Tools accordion
message actions
cloud sync client
```

The UI evolved from simple chat bubbles into a product interface.

### 4. Voice state machine

Voice input was unstable at first.

There were browser edge cases:

```txt
no-speech loops
network errors
retry bugs
waveform still running
mobile browser differences
continuous recognition issues
```

Copilot helped rebuild the voice code as an explicit state machine.

This made the system predictable.

### 5. Memory v2

The first memory system was too simple.

Copilot helped evolve it into structured memory:

```txt
preferred name
important people
aliases
communication preferences
relationship facts
avoided responses
memory inspector
cloud/local sync
```

This gave MindPal a durable identity layer.

### 6. Clinical framework RAG

Copilot helped wire the grounding corpus:

```txt
multi-directory YAML loading
valid tag alignment
failed file tracking
panic grounding
DBT STOP
cognitive reframe
relationship safety
study triage
RAG health endpoint
tests
```

This made the AI less random and more grounded.

### 7. Debugging production issues

Copilot was used to debug real deployment problems:

```txt
Firebase authorized domain errors
profile route connection errors
CORS/API URL issues
chat history not sent to backend
semantic intake not injected into prompts
voice no-speech retry loops
iOS/mobile speech behavior
Discord Open Graph asset 404s
favicon routing
Cognitive Tools parser failures
cloud chat sync bugs
```

The workflow was always:

```txt
observe
  -> isolate subsystem
  -> patch narrowly
  -> verify locally
  -> deploy
  -> inspect logs
  -> harden architecture
```

### 8. Testing and verification

Copilot helped create focused checks:

```txt
pytest for RAG
pytest for memory v2
compileall backend tests
node --check frontend JS
manual regression checklist
Vercel log inspection
curl route verification
Discord preview verification
```

This kept the project from collapsing as features increased.

---

## Current Status

MindPal currently includes:

```txt
web UI
auth
local mode
cloud mode
cloud chat sync
memory v2
memory inspector
voice input
mobile voice improvements
semantic intake
response modes
Cognitive Tools UI
clinical framework RAG
safety routing
output guard
provider fallback
Open Graph metadata
Discord/Twitter preview assets
Vercel deployment
```

---

## Local Development

### Requirements

```txt
Python 3.12+
Node.js
Firebase project for auth/cloud features
Cloudflare AI Gateway or another configured LLM provider
```

### Setup

```powershell
python -m venv .venv
. .venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

Create environment file:

```powershell
copy .env.example .env
```

Configure provider/auth values.

Common variables:

```txt
LLM_PROVIDER_ORDER=cloudflare,openrouter,groq

CF_AIG_TOKEN=
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_GATEWAY_ID=
CLOUDFLARE_MODEL=

FIREBASE_...
GOOGLE_APPLICATION_CREDENTIALS=...
```

Run locally:

```powershell
uvicorn backend.main:app --reload
```

Open:

```txt
http://localhost:8000
```

---

## Testing

Backend:

```powershell
python -m compileall backend tests -q
python -m pytest -q
```

Frontend syntax:

```powershell
node --check frontend/js/app.js
node --check frontend/js/api.js
node --check frontend/js/voice.js
node --check frontend/js/memory_engine.js
node --check frontend/js/voice_languages.js
```

RAG health:

```powershell
curl.exe "http://localhost:8000/api/rag/health"
```

Brand assets:

```powershell
curl.exe -I "http://localhost:8000/assets/brand/og-image.png"
curl.exe -I "http://localhost:8000/site.webmanifest"
curl.exe -I "http://localhost:8000/favicon.ico"
```

---

## Manual Regression Checklist

### Voice

```txt
- click mic
- speak one sentence
- transcript appears
- accept inserts transcript
- cancel closes panel
- silence goes to retry
- no auto-retry loop
- mobile voice does not hang
```

### Chat Context

```txt
- ask how many messages are in the chat
- ask what the previous message was
- ask a follow-up question
- verify /api/chat request has non-empty history
```

### Memory

```txt
- say: my name is Marwan
- ask: what is my name?
- say: my girlfriend is called مي, also Mi or Maya
- ask: who is Mi?
- edit/delete memory in inspector
- refresh and verify memory remains
```

### Cloud

```txt
- login
- send message
- refresh
- chat remains
- open second browser with same account
- memory and chat appear
- clear chat deletes cloud current chat
```

### Cognitive Tools

```txt
Prompt:
Don’t comfort me generally.
Use the exact Cognitive Tools format:
Thought, Distortion, Evidence For, Evidence Against, Balanced Reframe, Next Tiny Action.
My thought is: “If I don’t fix everything today, I’m a failure.”

Expected:
- accordion renders analysis
- Balanced Reframe is visible below
- Next Action is visible below
- no duplicate reframe inside accordion
```

### RAG

```txt
- panic prompt retrieves panic grounding
- anger prompt retrieves DBT STOP
- overthinking prompt retrieves cognitive reframe
- relationship distress retrieves boundary/safety
```

### Arabic

```txt
- Egyptian Arabic input gets Egyptian Arabic output
- relationship distress is understood
- no formal MSA unless user writes formal Arabic
- no random identity questions
```

---

## Deployment

MindPal is deployed on Vercel.

After deployment:

```powershell
curl.exe "https://mindpal-demo.vercel.app/api/health"
curl.exe "https://mindpal-demo.vercel.app/api/rag/health"
curl.exe -I "https://mindpal-demo.vercel.app/assets/brand/og-image.png"
curl.exe -I "https://mindpal-demo.vercel.app/site.webmanifest"
curl.exe -I "https://mindpal-demo.vercel.app/favicon.ico"
```

Expected:

```txt
200 OK
```

Discord/Twitter previews use:

```txt
og:title
og:description
og:image
twitter:card
twitter:image
```

If Discord shows an old preview, cache-bust:

```txt
https://mindpal-demo.vercel.app/?v=brand2
```

---

## Security and Privacy Notes

MindPal separates privacy modes clearly.

```txt
Guest:
  data stays local

Signed in:
  cloud sync is enabled
```

Important principles:

```txt
- do not store raw chat as memory
- do not expose provider tokens to frontend
- do not let LLM guess known product facts
- do not rely on LLM for crisis bypass
- do not diagnose users or other people
- keep memory inspectable/editable
```

---

## What MindPal Is Not

MindPal is not:

```txt
a therapist replacement
a diagnosis engine
a crisis hotline
a generic chatbot wrapper
a Discord bot anymore
```

MindPal is:

```txt
a private AI support tool
a structured thinking companion
a voice journal
a memory-aware chat system
a grounded coping assistant
```

---

## Roadmap

Possible next improvements:

```txt
response debug panel
multi-chat sessions
server-side transcription for iOS reliability
better analytics for mode/RAG selection
user-controlled memory categories
export/import memory
full Arabic UI mode
custom user instructions
account deletion flow
provider cost dashboard
```

---

## Build Philosophy

MindPal was built with one operating rule:

```txt
Understand first. Then answer.
```

Every major subsystem supports that rule.

```txt
semantic intake
  understands meaning

memory
  remembers what matters

RAG
  grounds techniques

modes
  shape response behavior

safety
  protects high-risk moments

chat history
  preserves context

voice
  lowers friction

cloud sync
  keeps continuity
```

The result is an AI companion that does more than respond.

It follows the user’s context.

---

## Final Summary

MindPal began as a minimal Discord mental-health companion.

Through Copilot-assisted development, it became a complete AI support platform:

```txt
private
voice-enabled
memory-aware
mode-aware
safety-routed
RAG-grounded
cloud-synced
production-deployed
```

MindPal is built for people who do not need generic motivation.

They need clarity.

They need control.

They need something that remembers.

---

## MindPal

```txt
AI support that remembers what matters.
```

```
```