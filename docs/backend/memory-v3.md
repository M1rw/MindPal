# Memory System — Adaptive Cortical Memory (ACM)

## Overview

MindPal's memory system (V3) uses an **Adaptive Cortical Memory (ACM)** graph architecture that persists user facts, preferences, relationships, and behavioral patterns across sessions.

```mermaid
graph TB
    subgraph "Memory Graph"
        direction TB
        GRAPH["MemoryGraph"]
        GRAPH --> A1["MemoryAtom<br/>profile/name<br/>'Sarah'"]
        GRAPH --> A2["MemoryAtom<br/>people/partner<br/>'Alex'"]
        GRAPH --> A3["MemoryAtom<br/>patterns/anxiety_trigger<br/>'work deadlines'"]
        GRAPH --> A4["MemoryAtom<br/>goals/sleep<br/>'improve sleep schedule'"]
        GRAPH --> A5["MemoryAtom<br/>avoid/response_style<br/>'apologetic tone'"]
        GRAPH --> A6["MemoryAtom<br/>coping_tools/breathing<br/>'box breathing works'"]
    end

    style GRAPH fill:#9b72cb,color:white
    style A1 fill:#4285f4,color:white
    style A2 fill:#34a853,color:white
    style A3 fill:#ea4335,color:white
    style A4 fill:#fbbc04,color:black
    style A5 fill:#ff6d01,color:white
    style A6 fill:#46bdc6,color:white
```

## MemoryAtom Schema

Each memory fact is stored as a `MemoryAtom`:

```
MemoryAtom {
  id              string    Unique identifier (UUID)
  category        string    One of the 10 categories
  key             string    Human-readable key within category
  value           string    The actual memory content
  normalized_value string   Lowercased, trimmed for dedup
  display_value   string    User-facing display text
  confidence      float     0.0–1.0 (how certain we are)
  sensitivity     string    "low" | "medium" | "high"
  source          string    "extraction" | "manual" | "migration"
  status          string    "active" | "deleted" (tombstone)
  pinned          boolean   User pinned (protected from auto-update)
  created_at      ISO date  When first created
  updated_at      ISO date  Last modification
  last_seen_at    ISO date  Last time evidence appeared
  evidence_count  int       How many times confirmed
  aliases         string[]  Alternative names/references
  metadata        object    Extra structured data
}
```

## Memory Categories

```mermaid
mindmap
  root((Memory Graph))
    Profile
      preferred_name
      age
      location
      language
    People
      partner
      family
      friends
      therapist
    Patterns
      anxiety_triggers
      emotional_cycles
      sleep_patterns
      stress_responses
    Goals
      therapy_goals
      lifestyle_changes
      relationship_goals
    Preferences
      communication_style
      response_length
      topic_preferences
    Avoid
      unwanted_responses
      sensitive_topics
      triggering_content
    Coping Tools
      breathing_exercises
      grounding_techniques
      what_works
    Relationship Context
      dynamics
      recurring_issues
      support_network
    Safety Context
      crisis_history
      emergency_contacts
      risk_factors
    Facts
      occupation
      hobbies
      general_info
```

## Memory Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Extracted: AI extracts from conversation
    [*] --> Manual: User edits in inspector
    [*] --> Migrated: Imported from v2

    Extracted --> Active: Confidence > threshold
    Manual --> Active: Immediate
    Migrated --> Active: Auto-migrated

    Active --> Updated: New evidence found
    Updated --> Active: Merge complete
    Active --> Deleted: User removes
    Deleted --> Tombstoned: Backend stores tombstone
    Tombstoned --> [*]: Cannot be auto-recreated

    note right of Tombstoned
        Deleted atoms stay as tombstones.
        Non-manual extraction cannot
        recreate tombstoned atoms.
    end note
```

## Memory in the Chat Flow

```mermaid
sequenceDiagram
    participant User
    participant Frontend
    participant Backend
    participant MemoryGraph
    participant Firestore

    User->>Frontend: Sends message
    Frontend->>Backend: Message + context

    Backend->>MemoryGraph: Load user's graph
    MemoryGraph-->>Backend: Active atoms

    Backend->>Backend: Build prompt with memory context
    Note over Backend: Memory injected as:<br/>"You know: Name is Sarah,<br/>Partner is Alex, etc."

    Backend->>Backend: Generate AI response

    Backend->>Backend: Extract memory delta
    Note over Backend: Deterministic extraction:<br/>new facts mentioned in<br/>the conversation

    Backend->>MemoryGraph: Merge delta
    Note over MemoryGraph: Same key? Update.<br/>New key? Create atom.<br/>Tombstoned? Skip.

    MemoryGraph->>Firestore: Save updated graph

    Backend-->>Frontend: Response + memory_graph_delta
    Frontend->>Frontend: Merge delta into local graph
    Frontend->>Frontend: Update Memory Inspector UI
```

## Merge Rules (Deterministic)

```mermaid
flowchart TD
    START["Incoming Atom"] --> CHECK{"Same category/key<br/>already exists?"}
    
    CHECK -->|"No"| NEW["Create new atom"]
    CHECK -->|"Yes"| TOMB{"Existing atom<br/>tombstoned?"}
    
    TOMB -->|"Yes, source=extraction"| SKIP["Skip (cannot recreate)"]
    TOMB -->|"Yes, source=manual"| OVERRIDE["Recreate (manual override)"]
    TOMB -->|"No"| PINNED{"Existing atom<br/>pinned?"}
    
    PINNED -->|"Yes"| KEEP_TEXT["Keep display text<br/>Update metadata only"]
    PINNED -->|"No"| CONF{"New confidence<br/>≥ existing?"}
    
    CONF -->|"Yes"| UPDATE["Update value<br/>Increment evidence_count"]
    CONF -->|"No"| EVIDENCE["Increment evidence_count<br/>Keep existing value"]
    
    NEW --> SAVE["Save to graph"]
    OVERRIDE --> SAVE
    KEEP_TEXT --> SAVE
    UPDATE --> SAVE
    EVIDENCE --> SAVE

    style START fill:#4285f4,color:white
    style SKIP fill:#ea4335,color:white
    style SAVE fill:#34a853,color:white
```

### Key Merge Principles
1. **Partial deltas never replace the graph** — only merge into it
2. **Empty fields don't delete** — missing fields are ignored
3. **Aliases merge** — new aliases are added to existing sets
4. **People merge by alias/relationship** when safe to do so
5. **Timestamps move forward** — `updated_at` and `last_seen_at` never go backward

## Storage Architecture

```mermaid
flowchart LR
    subgraph "Guest User"
        LS["localStorage<br/>mindpal_memory_graph"]
    end

    subgraph "Signed-in User"
        LS2["localStorage<br/>(offline cache)"]
        FS["Firestore<br/>memory_graphs/{uid}"]
    end

    subgraph "Backend"
        DB_SVC["db_service.py<br/>load/save/delete"]
        MG_SVC["memory_graph_service.py<br/>merge/render/extract"]
    end

    LS2 <-->|"Sync on load"| FS
    DB_SVC <--> FS
    MG_SVC --> DB_SVC

    style FS fill:#fbbc04,color:black
    style LS fill:#4285f4,color:white
```

## Memory Inspector (Frontend)

The Memory Inspector is accessible from the Settings panel. It displays all active memory atoms grouped by category as interactive cards with chips:

```
┌─────────────────────────────────────────┐
│  Memory Inspector                       │
├─────────────────────────────────────────┤
│                                         │
│  👤 Profile                             │
│  ┌──────────┐ ┌───────────────┐         │
│  │ Sarah  ✕ │ │ 25 years old ✕│         │
│  └──────────┘ └───────────────┘         │
│                                         │
│  👥 People                              │
│  ┌─────────────────┐ ┌──────────┐       │
│  │ Alex (partner) ✕│ │ Mom    ✕ │       │
│  └─────────────────┘ └──────────┘       │
│                                         │
│  🚫 Avoid                               │
│  ┌──────────────────────┐               │
│  │ apologetic responses ✕│              │
│  └──────────────────────┘               │
│                                         │
│  🎯 Goals                               │
│  ┌─────────────────────┐                │
│  │ improve sleep      ✕ │               │
│  └─────────────────────┘                │
└─────────────────────────────────────────┘
```

### Chip Deletion Flow
1. User clicks ✕ on a chip
2. Atom marked as `status=deleted` locally
3. If signed in → `DELETE /api/memory/v3/items/{atom_id}`
4. Backend stores tombstone
5. Auto-extraction cannot recreate tombstoned atoms

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/memory/v3` | Load full memory graph |
| `PUT` | `/api/memory/v3` | Replace entire graph |
| `PATCH` | `/api/memory/v3` | Merge partial delta |
| `DELETE` | `/api/memory/v3/items/{id}` | Delete single atom (tombstone) |
| `POST` | `/api/memory/v3/merge` | Merge external graph |
| `POST` | `/api/memory/v3/migrate` | Migrate from v2 to v3 |

## Prompt Integration

Memory is injected into the system prompt as a structured block:

```
You know the following about this user (verified facts — may be outdated):
⚠️ This memory may be outdated. Verify key facts if the conversation contradicts stored information.

Profile:
  - Name: Sarah
  - Age: 25

People:
  - Partner: Alex (together 3 years)
  - Mom: close relationship, supportive

Patterns:
  - Anxiety spikes before work deadlines
  - Sleep worsens during stress periods

Goals:
  - Improve sleep schedule
  - Better work-life boundaries

Avoid:
  - Apologetic tone in responses
  - Over-validation without substance
```

The memory block sits between `PRODUCT_BOUNDARY_PROMPT` and `THOUGHT CHAIN GUIDELINES` in the prompt stack.
