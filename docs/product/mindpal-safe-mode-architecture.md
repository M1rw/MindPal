# MindPal // SAFE MODE — Runtime Architecture Map

## Existing system map

MindPal is a **FastAPI backend** deployed with a vanilla JavaScript/ESM frontend bundled by esbuild. `frontend/js/app.js` owns normal chat interaction and calls `sendChatMessageStream`. The backend route `POST /api/chat/stream` runs the real user-facing request pipeline. Its response transport is SSE, but output is intentionally safety-buffered: pipeline work completes before `_stream_response` yields reply chunks.

```text
Browser app.js
  └─ POST /api/chat/stream (SSE response transport)
       ├─ rate limit / idempotency / quota reservation
       ├─ safety input classification
       ├─ deterministic safety or chat-context shortcut (when applicable)
       ├─ profile + Memory V3 load / Brain context planning (authenticated and permitted)
       ├─ RAG contextual retrieval
       ├─ tool routing + bounded pre-execution (when relevant)
       ├─ prompt construction
       ├─ LLMService.generate_with_trace (provider cascade trace)
       ├─ output guard / rewrite
       ├─ memory persistence (when permitted)
       ├─ quota commit / metadata preparation
       └─ buffered SSE text chunks + status + metadata
```

| Runtime capability | Existing authoritative seam | SAFE MODE visibility |
|---|---|---|
| Run start / completion / failure | `chat_stream` route | Real run events, timestamps, duration, request ID |
| Safety path | `safety.classify_input_with_context` | `SESSION` / `GUARDRAILS` node, outcome only |
| Memory load / context planning | `memory_repo.load`, `brain.plan_context` | `MEMORY` / `CONTEXT` nodes only when permitted and used |
| Retrieval | `rag.retrieve_contextual` | `RETRIEVAL` node with candidate/reference counts only |
| Tool decision + execution | `_pre_execute_tools` / registry | `TOOL_ROUTER` and specific tool nodes with outcome/duration only |
| Model call / provider fallback | `llm.generate_with_trace` | `MODEL` node and sanitized provider-chain trace |
| Response checking | `output_guard.validate_output_with_rewrite` | `EVALUATOR` / `SYNTHESIS` nodes, rewrite boolean only |
| Memory update | `_persist_memory_graph_inline` | `MEMORY` completion state and changed boolean only |

## Realtime boundary and decision

Existing SSE is a **safe buffered reply channel**, not an execution-event stream. The voice WebSocket is dedicated to live voice and must not be reused. SAFE MODE therefore uses a canonical, request-scoped `RuntimeEvent` contract recorded at the backend execution seams above. The completed sanitized trace is delivered as part of the existing chat-stream metadata, preserving the current API transport and safety behavior.

For live same-device visualization while a run is in progress, the chat client emits only local lifecycle signals over a same-origin `BroadcastChannel`; after the backend response arrives, it reconciles the display with the canonical sanitized backend trace. This avoids an unauthenticated cross-user runtime feed, does not require polling, and never exposes message content, tokens, user identity, prompts, provider credentials, or tool payloads.

## SAFE MODE graph topology

The debugger graph uses stable, deterministic columns—not a force layout:

```text
INPUT → SESSION → [CONTEXT / MEMORY / RETRIEVAL] → TOOL ROUTER → [WEB / TIME / MEMORY SEARCH] → MODEL → EVALUATOR → SYNTHESIS → OUTPUT
```

Nodes appear only when the authoritative trace includes the underlying operation. Failure creates an `ERROR` terminal branch. Tool branches retain their parent tool-router relationship. The reference design’s columns represent stable runtime stages rather than artificial neurons or model layers.

## Event contract

Every event includes `run_id`, `sequence`, `timestamp_ms`, `kind`, `node`, `status`, optional bounded `duration_ms`, and sanitized metadata. Supported kinds are: `run.started`, `node.started`, `node.completed`, `memory.retrieved`, `tool.started`, `tool.completed`, `model.started`, `model.completed`, `error`, and `run.completed`.

SAFE MODE is public as a shell, but no prior user run trace is persisted or shared into the page. It attaches only to new local browser lifecycle messages and locally cached, sanitized response traces.

## Production layout validation

Cache-bypassed production validation for commit `827419d` confirmed that `/brain` now renders the requested SAFE MODE console composition: near-black terminal shell, fixed system bar, left diagnostic rail, wide graph viewport, node/activity/legend inspection panes, terminal trace strip, and command footer. The graph correctly presents an explicit empty state until a real MindPal run is observed; it does not fabricate model activity.
