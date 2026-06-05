# Current State And Roadmap

The pasted plan is directionally right: stabilize first, then add RAG, then memory, observability, tests, and release polish. The improved order below separates baseline preservation from feature work and avoids mixing risky systems.

Current state:

```txt
Stable baseline:
  voice state machine exists
  chat sync/history behavior has been stabilized
  semantic intake exists

RAG:
  backend/rag/corpus is the original corpus directory
  data/clinical_frameworks is now an added corpus source
  /api/rag/health exists
  retrieval tests exist for panic, anger, overthinking, and Arabic relationship distress

Memory:
  local/basic memory exists
  durable structured Memory v2 is still the next major feature

Observability:
  health endpoints exist
  debug/observability panel is still planned

Release:
  deployment exists
  release flow still needs a tighter checklist and automated confidence gates
```

Recommended execution order from here:

```txt
1. Keep baseline clean and pushed.
2. Run regression checklist before risky changes.
3. Expand/maintain clinical framework RAG corpus.
4. Build Memory v2.
5. Add debug/observability panel.
6. Add broader automated tests.
7. Polish release/deploy flow.
```

Why RAG came before Memory v2:

```txt
RAG improves response safety and consistency immediately.
It is product-wide and low-personal-data.
It reduces "LLM vibes" for panic, anger, study stress, overthinking, and relationship distress.
It creates stable retrieval tests.
```

Why Memory v2 should come next:

```txt
The app needs persistent identity and relationship context:
  preferred_name
  important_people
  relationship facts
  communication preferences
  emotional triggers
  user goals
  avoided responses

Without Memory v2, the model can answer a single conversation well but cannot reliably remember stable user facts across sessions.
```

Commit themes:

```txt
add clinical framework RAG corpus
add durable structured memory
add MindPal debug panel
expand backend regression tests
document release checklist
```

Do not bundle these into one commit.

