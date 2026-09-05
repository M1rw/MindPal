# Data Model & Schema Audit

## Overview & Core Schemas

MindPal's domain model centers around three core entities: `UserProfile` (`backend/models/user.py`), `MemoryGraph` (`backend/models/memory.py`), and `ChatRequest` / `ChatMessage` (`backend/models/chat.py`).

---

## 1. User Profile & Clinical Schema

### `UserProfile` Model (`backend/models/user.py:199`)
- **`user_id`**: String identifier or user ID hash (`usr_...`).
- **`created_at` / `updated_at`**: ISO timestamps.
- **`personalization`**: `UserPersonalization` sub-model (`baseStyle`, `warmth`, `useHeadersLists`, `emojiSupport`).
- **`clinical`**: `ClinicalProfile` containing:
  - **`phq9_history`**: List of `ClinicalScore(score: int, date: str, note: Optional[str])`.
  - **`gad7_history`**: List of `ClinicalScore(score: int, date: str, note: Optional[str])`.
  - **`last_screening_date`**: ISO date string of most recent clinical assessment.

---

## 2. Memory Graph Schema

### `MemoryGraph` Model (`backend/models/memory.py:470`)
- **`version`**: Integer version counter for optimistic concurrency checks (`MemoryVersionConflictError`).
- **`updated_at`**: ISO timestamp string.
- **`nodes`**: Dictionary mapping `atom_id` to `MemoryAtom` nodes.
  - Each `MemoryAtom` contains `id`, `category` (`core_trait`, `relationship`, `emotional_pattern`, `coping_skill`, `goal`), `value`, `confidence` (0.0–1.0), `provenance`, and `last_updated`.
- **`edges`**: List of `MemoryEdge(source_id: str, target_id: str, relationship: str)`.
- **`collections`**: List of `BrainCollection` items storing high-level summary narrative sections (e.g. `## Overview`, `## Emotional Patterns & Coping`).

---

## 3. Critical Semantics & Discrepancy Flags

### Flag A: `message_count` Semantics Mismatch
- **Issue**: In test persona fixtures (`data/audit_fixtures/*.json`), `message_count` is set at the root level (e.g., `"message_count": 300`). However, in `UserProfile` (`backend/models/user.py`), total chat interaction count is stored separately inside `stats.total_messages` or computed dynamically from the chat store backend (`chat_store.py`).
- **Impact**: Code reading persona fixtures expecting a root-level `message_count` fails to map to `UserProfile.stats`, leading to default/zero values during analytics or prompt generation.

### Flag B: Clinical Score Sources of Truth
- **PHQ-9 & GAD-7**: Stored in `profile.clinical.phq9_history` and `profile.clinical.gad7_history` (`user.py:163-164`).
- **Clinical Extractor Injection**: `extract_clinical_inline` parses chat completions and appends new scores.
- **Discrepancy**: Score records in `UserProfile` do not automatically synchronize with Supabase SQL tables or standalone screening session collections unless explicitly flushed by `UserService`.

### Flag C: Timeline & Date Handling
- **Timestamp Formats**: Mixing UTC ISO strings (`YYYY-MM-DDTHH:MM:SSZ`) in `MemoryAtom.last_updated` and simple date strings (`YYYY-MM-DD`) in `ClinicalScore.date`.
