# Memory V2

Memory v2 stores durable structured facts, not raw chat logs. It is implemented
as a shared contract between backend compaction, Firestore-backed memory APIs,
guest local storage, and the frontend Memory Inspector.

Structured fields:

```txt
preferred_name
important_people
relationship_facts
communication_preferences
emotional_triggers
user_goals
avoided_responses
updated_at
source_confidence
```

Backend model:

```txt
backend/models/memory.py
  MemorySummary
  ImportantPerson
  RelationshipFact
  CommunicationPreferences
```

Backend service:

```txt
backend/services/memory_service.py
  deterministic extraction
  optional LLM compaction
  structured merge
  prompt summary rendering
  PII/secret redaction
```

Frontend model:

```txt
frontend/js/memory_engine.js
  guest local Memory v2 store
  backend summary conversion
  lightweight client extraction
  inspector row formatting
```

Frontend surface:

```txt
frontend/index.html
  Settings -> What MindPal remembers

frontend/js/app.js
  cloud user -> GET/PUT /memory
  guest user -> localStorage
  edit/delete inspector rows
```

Example:

```json
{
  "preferred_name": "Marwan",
  "important_people": [
    {
      "canonical_name": "مي",
      "aliases": ["Mi", "Maya"],
      "relationship": "girlfriend",
      "notes": ["important relationship context"],
      "confidence": "high"
    }
  ],
  "relationship_facts": [
    {
      "summary": "User discusses recurring relationship distress involving مي.",
      "confidence": "medium"
    }
  ],
  "communication_preferences": {
    "tone": "direct",
    "language": "Egyptian Arabic when user writes Egyptian Arabic",
    "avoid": ["generic identity questions", "formal MSA for dialect input"]
  },
  "emotional_triggers": ["relationship uncertainty"],
  "user_goals": [],
  "avoided_responses": ["random self-discovery questions when relationship issue is clear"]
}
```

Storage rule:

```txt
Cloud user
  -> Firestore memory

Guest user
  -> local memory
```

API rule:

```txt
GET /api/memory
  returns authenticated user's scoped MemorySummary

PUT /api/memory
  accepts MemorySummary but rebinds user_id_hash to the authenticated session

POST /api/memory/compact
  compacts supplied interaction fragments into structured memory
```

Identity priority:

```txt
explicit memory.preferred_name
  > profile name entered by user
  > Firebase displayName
  > email local part
  > anonymous fallback
```

Memory extraction rules:

```txt
Store:
  stable names
  repeated preferences
  important relationship context
  clear goals
  explicit "remember this" facts
  repeated "don't respond like this" preferences

Do not store:
  one-off vents
  raw secrets
  full chat transcripts
  medical diagnoses
  speculative labels about other people
  sensitive details not needed for support
```

Update behavior:

```txt
1. Extract candidate facts after assistant response.
2. Normalize aliases and field names.
3. Assign confidence.
4. Merge with existing memory.
5. Never duplicate the same person because of Arabic/Latin aliases.
6. Let user delete/edit memory later.
```

Implemented extraction examples:

```txt
"My name is Marwan"
  -> preferred_name=Marwan

"My girlfriend is named Maya. I may write her name as Mi or Maya"
  -> important_people[0].canonical_name=Maya
  -> aliases include Maya, Mi

"I prefer direct answers"
  -> communication_preferences.tone=direct
  -> response_style includes direct answers

"Do not answer like random identity questions"
  -> avoided_responses includes random identity questions
```

Merge rules:

```txt
same alias overlap
  -> merge person records

one existing intimate partner with same relationship
  -> merge aliases instead of duplicating the partner

new communication preference
  -> fills empty scalar fields and merges list fields

relationship facts
  -> deduplicated by normalized summary text
```

Memory Inspector target:

```txt
Settings -> What MindPal remembers

Name:
  Marwan

Important people:
  مي / Mi / Maya

Preferences:
  direct answers
  Egyptian Arabic for dialect input

Actions:
  edit
  delete
  clear all memory
```

Security and privacy:

```txt
Authenticated memory must be scoped to user id.
Guest memory must stay local.
Memory API responses must not leak other users' facts.
Memory debug UI must require the current user session.
```

Tests:

```txt
tests/test_memory_v2.py
  extracts preferred name, important people, aliases, preferences, avoided responses
  merges partner aliases and communication preferences
  renders structured memory into the prompt summary
```
