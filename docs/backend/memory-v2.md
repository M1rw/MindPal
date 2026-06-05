# Memory V2

Memory v2 should store durable structured facts, not raw chat logs.

Target fields:

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

