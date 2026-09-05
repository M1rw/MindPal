# Persona Fixtures ↔ Code Alignment Audit

## Audit Overview

The repository includes static persona test fixtures located under `data/audit_fixtures/` (`active_persona.json`, `bilingual_persona.json`, `distressed_persona.json`, `new_persona.json`, `screening_persona.json`, `sporadic_persona.json`). This audit checks how backend code (`backend/models/user.py`, `backend/services/domain/llm/chat_orchestrator.py`) consumes these fields.

---

## Schema Alignment Matrix

| Persona Field | Consumed By Code? | Active Code Path / Usage | Status / Notes |
|---|---|---|---|
| `user_id` | ✅ Yes | Mapped to `UserProfile.user_id`. | Fully active. |
| `personalization` | ✅ Yes | Injected into system prompt by `build_user_preferences_prompt` (`chat_orchestrator.py:126`). | Fully active. |
| `clinical.phq9_history` | ✅ Yes | Sliced (`[-5:]`) and appended to prompt context in `chat_orchestrator.py:213`. | Fully active. |
| `clinical.gad7_history` | ✅ Yes | Sliced (`[-5:]`) and appended to prompt context in `chat_orchestrator.py:216`. | Fully active. |
| `memory_graph` | ⚠️ Partially | Loaded via `MemoryGraph.model_validate`, but root `version` field from fixture is sometimes ignored in legacy memory endpoints. | Partially used. |
| `message_count` | ❌ **Dead Weight** | Persona JSONs define `"message_count": 300` at the root level, but `UserProfile` stores message stats under `stats.total_messages`. Root field is ignored. | **Dead Weight**. |
| `memory_summary` | ⚠️ Partially | `memory_summary.summary` is read in benchmark scripts (`profile_llm_tokens.py`), but ignored in main API routes in favor of dynamic `MemoryGraph` rendering. | Partially used. |
