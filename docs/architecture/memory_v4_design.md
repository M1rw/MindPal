# MindPal Memory v4 Architecture & Design Document
**Domain:** AI Mental Health Companion Architecture
**Status:** Approved Specification (Phase 1 Deliverable)
**Author:** Principal Product Engineer

---

## 1. Vision & Core Mindset

MindPal is an AI mental-health companion, not a general chatbot. General-purpose memory architectures (such as ChatGPT's) treat facts, entities, and preferences as flat database rows. For a mental health companion, factual memory is secondary to **emotional memory**: safely understanding a person's emotional journey, context, triggers, coping strategies, screening score patterns, and progress over time.

### Guiding Principles:
1. **Emotional Journey over Fact Lists:** We capture emotional tone, triggers, growth, and effective coping mechanisms rather than transactional facts.
2. **Privacy & User Empowerment as Core Pillars:** Mental health data is sensitive. Transparency, correction, redaction, and total deletion controls are built into every layer.
3. **Warm, Non-Clinical Language:** UI and system prompts use gentle, supportive phrasing ("What MindPal remembers to support you best") rather than medical surveillance terminology.
4. **Safety-First Retention & Redaction:** Mental-health crises, diagnostic claims, and screening history are subject to strict sensitive-data policies (summarized safely without diagnostic labels; crisis logs maintained with 30-day safety retention).

---

## 2. Core Concepts & Functional Architecture

### 2.1 Memory Summary (AI-Synthesized Context)
Replaces legacy static durable-memory fields.
- **Synthesized Profile:** MindPal maintains a dynamically generated, continuously updated emotional context summary for each user.
- **Freshness Indicator:** Displays "Last updated [time ago]" (e.g. "Last updated 12 minutes ago").
- **Incremental Auto-Update:** As new messages/reflections occur, background jobs run the synthesis pipeline to integrate new emotional context and remove outdated info.

### 2.2 Editable & Correctable Context
Users hold absolute authority over what MindPal remembers.
- **Natural Language Requests:** A text input at the base of the summary allows requests like: *"Stop remembering my exam stress, I passed!"*
- **Highlight-to-Correct:** Highlighting any section of text in the summary opens a context menu: "Correct this fact", "Remove section", or "Mark private".
- **Granular Item Management:** Individual extracted items (atomic memory nodes) can be deleted directly from a list view.

### 2.3 Automatic Memory Management & De-duplication
- **Contradiction Resolution:** Automatically resolves shifts in state (e.g., transition from "anxious about public speaking" to "felt confident during yesterday's presentation").
- **De-duplication & Consolidation:** Merges overlapping emotional observations into coherent narrative summaries.
- **Decay & Relevance Weighting:** Outdated transient stressors decay over time unless reinforced.

### 2.4 Provenance & Sources Tracking
- **Response Sources:** Every generated response that accesses memory context logs the specific memory nodes utilized.
- **UI Inspection:** Users can click a gentle "Why MindPal remembered this" indicator on any response to see the precise memory nodes used, with direct options to edit or remove those sources immediately.

### 2.5 Granular Controls
- **Global Memory Toggle:** Turn Memory ON or OFF instantly.
- **"Delete & Turn Off":** Single-click button that wipes all stored user memory nodes and disables the memory engine.
- **Explicit Supporting Guidelines:** Clear separation between:
  1. *Memory Summary* (AI-learned emotional context)
  2. *Support Preferences* (Explicit user guidelines, e.g. "Always remind me to breathe when I feel overwhelmed")
  3. *Chat History* (Raw conversation logs)

### 2.6 Temporary Conversations
- **Incognito Mode:** Conversations flagged as `is_temporary: true` read zero existing memories and create zero new memory nodes or history logs.

### 2.7 Sensitive-Data Policy & Redaction Rules
| Category | Storage Policy | Synthesis Policy | Redaction / Safety |
| :--- | :--- | :--- | :--- |
| **Crisis Mentions (Self-Harm, Suicidal Ideation)** | Kept in secure safety audit log (30 days) | **NEVER** synthesized into durable memory summary | Suppressed from conversational memory; triggers immediate safety protocol |
| **Screening Results (PHQ-9, GAD-7, Mood Scores)** | Stored in encrypted analytics table | Synthesized **ONLY** as trend indicators (e.g. "Focusing on sleep quality recently") | Raw score numbers and diagnostic categories are excluded from LLM memory prompts |
| **Self-Diagnoses & Medical Statements** | Kept as raw user reflections | Transformed into user-expressed feelings (e.g. "User feels overwhelmed by sensory input") | Clinical labels (e.g. "User has Condition X") are prohibited from memory nodes |

### 2.8 Deletion Semantics & 30-Day Safety Log
- **User Memory Deletion:** Instantly purges items from active LLM context and search indexes.
- **Safety Retention:** Memory items deleted by the user are moved to a 30-day soft-delete retention window accessible only by system safety recovery processes before permanent purge.

---

## 3. Data Models (Pydantic / Database Schema)

```python
# backend/services/domain/memory/schemas.py
from datetime import datetime
from typing import List, Optional, Dict, Any
from enum import Enum
from pydantic import BaseModel, Field

class MemoryCategory(str, Enum):
    EMOTIONAL_CONTEXT = "emotional_context"
    COPING_STRATEGY = "coping_strategy"
    TRIGGER = "trigger"
    GROWTH_PROGRESS = "growth_progress"
    USER_PREFERENCE = "user_preference"
    GENERAL_STRESSOR = "general_stressor"

class SensitiveLevel(str, Enum):
    STANDARD = "standard"
    SENSITIVE_HEALTH = "sensitive_health"
    CRISIS_REDACTED = "crisis_redacted"

class MemoryNode(BaseModel):
    id: str
    user_id: str
    content: str
    category: MemoryCategory
    sensitive_level: SensitiveLevel = SensitiveLevel.STANDARD
    confidence: float = 1.0
    source_chat_id: Optional[str] = None
    source_message_id: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    is_deleted: bool = False
    deleted_at: Optional[datetime] = None

class MemorySummary(BaseModel):
    user_id: str
    summary_text: str
    key_supports: List[str] = Field(default_factory=list)
    last_updated_at: datetime
    node_count: int = 0
    is_enabled: bool = True

class MemoryProvenance(BaseModel):
    response_id: str
    used_node_ids: List[str]
    used_summary_snippet: str
    reasoning: str

class MemoryEditRequest(BaseModel):
    instruction: Optional[str] = None
    highlighted_text: Optional[str] = None
    action: str = "update" # "update", "delete", "replace"
```

---

## 4. Synthesis Pipeline Architecture

```
  +------------------+     +-----------------------+     +------------------------+
  | User Conversation| --> | Sensitive Data Filter | --> | Emotional Extraction   |
  +------------------+     +-----------------------+     +------------------------+
                                                             |
                                                             v
  +------------------+     +-----------------------+     +------------------------+
  | Updated Summary  | <-- | De-duplication &      | <-- | Memory Node Creation   |
  | & Node Store     |     | Contradiction Resolv. |     | & Classification       |
  +------------------+     +-----------------------+     +------------------------+
```

1. **Extraction:** Post-conversation async task extracts candidate emotional memory nodes.
2. **Filtering:** Applies the Sensitive-Data Policy (redacting crisis mentions and raw medical scores).
3. **De-duplication & Contradiction Resolution:** Compares new candidate nodes with existing active nodes using vector similarity + LLM de-confliction.
4. **Summary Regeneration:** Synthesizes active memory nodes into a cohesive, warm summary paragraph and support checklist.

---

## 5. API Endpoints Specification

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/memory/summary` | Fetch current synthesized memory summary, freshness, and status |
| `PUT` | `/api/memory/summary` | User edits summary or submits natural language correction |
| `POST` | `/api/memory/refresh` | Trigger async manual summary re-synthesis |
| `GET` | `/api/memory/nodes` | List granular memory nodes with search/category filters |
| `DELETE` | `/api/memory/nodes/{node_id}` | Soft-delete specific memory node (30-day retention log) |
| `DELETE` | `/api/memory/all` | Wipe all memory nodes + summary ("Delete and Turn Off") |
| `PATCH` | `/api/memory/settings` | Toggle memory engine ON/OFF |
| `GET` | `/api/memory/provenance/{response_id}` | Retrieve sources used for a specific assistant response |

---

## 6. Frontend UI Design Specifications

1. **Memory Summary View (`frontend/components/modals/profile_modal.html` / `settings_ui.js`):**
   - Replaces all legacy "Brain workspace" elements.
   - Header: Warm card titled "What MindPal Remembers to Support You", showing "Last updated 5m ago".
   - Editable area with "Request an edit..." input box.
   - Granular memory list with delete icons per memory.
   - Global Memory Toggle & "Delete all memories" danger button.

2. **Provenance Popup (`frontend/js/ui/chat_ui.js`):**
   - Small, subtle icon next to assistant messages: *"Why MindPal remembered this"*.
   - Popover showing memory nodes referenced and button to *"Forget this context"*.
