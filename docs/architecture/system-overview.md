# System Overview

MindPal has six major subsystems:

```txt
Frontend UI
  chat rendering
  input state
  mode selection
  profile/settings
  voice state machine

Cloud identity and sync
  Firebase auth client
  backend session resolution
  Firestore chat persistence

Backend orchestration
  FastAPI routes
  request context
  safety service
  semantic intake
  response-mode selection
  RAG retrieval
  LLM provider chain
  output guard

RAG grounding
  backend/rag/corpus
  data/clinical_frameworks
  YAML grounding units
  deterministic local retrieval
  optional LLM retrieval planning

Memory
  guest local memory
  cloud durable structured memory
  profile and preference facts
  important people and aliases

Ops and observability
  health endpoints
  regression checklist
  debug panel target
  release/deploy flow
```

Main chat request flow:

```txt
User sends message
  -> frontend stores/render user message
  -> frontend sends latest message + history + mode/profile metadata
  -> backend resolves request/session/locale
  -> safety classification
  -> deterministic safety bypass if required
  -> semantic intake
  -> response mode inference
  -> RAG retrieval
  -> memory/profile context
  -> prompt construction
  -> LLM provider chain
  -> output guard
  -> memory compaction/update
  -> frontend renders assistant response
  -> guest: local persistence
  -> signed-in: Firestore sync
```

The critical separation:

```txt
Raw chat history
  What was said in this conversation.

Durable memory
  Stable facts/preferences worth remembering across conversations.

Clinical RAG corpus
  Curated safe technique instructions. Not user-specific.

Semantic intake
  Deterministic interpretation layer for the latest user need.
```

Wrong architecture:

```txt
LLM guesses user facts from raw old messages forever.
LLM invents grounding technique details.
Voice retry logic hidden inside scattered callbacks.
Cloud chat sync and local guest history overwrite each other.
```

Target architecture:

```txt
The app owns product state.
The RAG corpus owns technique constraints.
Memory owns durable user facts.
The LLM writes the final supportive response inside those boundaries.
```

