# Debug And Observability Panel

The debug panel should make MindPal explain what happened without exposing secrets or raw private memory.

Target location:

```txt
Settings or developer-only panel
```

Recommended fields:

```txt
request_id
response_mode
safety_level
locale
history_count_sent
history_count_seen_by_backend
rag_units_loaded
rag_matches
memory_source
memory_facts_count
llm_provider_used
fallback_used
cloud_sync_state
auth_state
```

RAG debug example:

```json
{
  "rag": {
    "units_loaded": 58,
    "matches": [
      {
        "grounding_id": "clinical_cognitive_reframe_overthinking",
        "score": 0.24,
        "tags": ["cognitive_reframe", "emotion_labeling"]
      }
    ],
    "failed_files": []
  }
}
```

Memory debug example:

```json
{
  "memory": {
    "source": "firestore",
    "preferred_name": "Marwan",
    "important_people_count": 1,
    "last_updated": "2026-06-05T18:00:00Z"
  }
}
```

Do not expose:

```txt
API keys
Firebase tokens
raw prompts
full raw memory if the user did not open Memory Inspector
provider credentials
other users' data
```

Why this matters:

```txt
"MindPal gave a dumb answer"
  debug panel shows whether mode, history, memory, RAG, or provider failed.

"It forgot my last message"
  debug panel shows history_count_sent and backend history count.

"Arabic output is formal"
  debug panel shows locale and semantic intake language_style.
```

