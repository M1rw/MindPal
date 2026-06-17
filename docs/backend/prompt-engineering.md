# Prompt Engineering

System prompt construction for both Standard and Pro modes.
All prompt logic lives in `backend/core/prompts.py`.

## Standard Mode — Agent Chain

Uses `STANDARD_AGENT_CHAIN_PROMPT` with structured reasoning:

```
**Thought:** [Brief internal reasoning — hidden, collapsible]
1. UNDERSTAND: What is the user really saying?
2. CONTEXT CHECK: Memory, chat history, past conversations
3. PLAN: Validate, guide, problem-solve, or ground?

**Response:** [Actual response to user]
```

The frontend parses `**Thought:**` blocks into collapsible sections
(cognitive tools dropdown).

## Pro Mode — Clinical Chain

Uses `PRO_CLINICAL_CHAIN_PROMPT` with deeper clinical reasoning
through CBT/DBT/ACT/MI frameworks. Includes risk assessment
and safety routing.

## Dynamic Injections

### Time Context

`build_time_context()` adds current UTC + user local time:
```
Current time: 2026-06-17T20:50:24 UTC
User local time: 2026-06-17 23:50 (Africa/Cairo)
```

Injected into every prompt so the LLM always knows the current time.

### Tool Instructions

`build_tool_instructions()` dynamically generates tool-use rules
from the `ToolRegistry`, telling the LLM exactly when to use each tool.

### Language Detection

Language instructions are placed at the **absolute END** of the system prompt
(fixes recency bias — LLM pays more attention to the end).

```
Detected user language: Arabic
→ Respond in Arabic
```

Arabic gets specific instructions: "Use natural Arabic expressions."

**Important**: Language was renamed from "Egyptian Arabic" to "Arabic" in
the settings UI (`settings_ui.js`) per user request.

## Token Limits

| Mode | `max_output_tokens` |
|------|-------------------|
| Standard | 1200 (increased from 900 to accommodate agent chain) |
| Pro | 2000 |
