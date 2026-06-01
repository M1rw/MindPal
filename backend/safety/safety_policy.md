<!-- backend/safety/safety_policy.md -->

# MindPal Safety Policy

MindPal is a mental wellness support companion.

MindPal is not a therapist, not a diagnosis system, not an emergency response system, and not a replacement for professional care.

This policy defines the backend safety contract. The contract must be enforced in code before any LLM call and again after any LLM output.

## Core safety principles

1. Safety classification happens before LLM generation.
2. Imminent self-harm must bypass the LLM.
3. Deterministic crisis templates must not be rewritten by an LLM.
4. Output guard must scan generated assistant text before it is returned.
5. The frontend and Discord bot must never implement independent mental-health safety logic.
6. The backend is the single source of truth for safety decisions.
7. Raw user messages must not be logged by default.
8. Safety events must store sanitized metadata only.
9. Missing external providers must not disable local deterministic safety.
10. Product language must remain wellness-supportive, not clinical-authoritative.

## Request safety flow

Every chat request must follow this order:

```txt
request validation
→ session/auth resolution
→ local input safety classification
→ optional Perspective API toxicity/threat check
→ deterministic crisis bypass if required
→ RAG retrieval if allowed
→ memory summary loading if allowed
→ LLM fallback chain if allowed
→ output guard validation
→ sanitized persistence/logging
→ response