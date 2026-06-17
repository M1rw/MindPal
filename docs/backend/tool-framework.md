# Tool Framework

Modular tool system for extending MindPal's capabilities beyond
pure LLM generation. Tools are server-side Python classes that can
be called by the chat router (pre-execution) or by voice sessions.

## Architecture

```
backend/tools/
├── __init__.py              # BaseTool, ToolResult, ToolContext, ToolRegistry
├── time_tool.py             # CurrentTimeTool, DateCalculatorTool
├── memory_search_tool.py    # MemorySearchTool, GetUserProfileTool
├── chat_search_tool.py      # GetRecentChatTool, SearchChatHistoryTool
├── web_search_tool.py       # WebSearchTool (DuckDuckGo, no API key)
└── voice_tools.py           # VoiceSummarizeTool, VoiceTranscribeTool
```

## Registered Tools (7)

| Tool Name | Class | Trigger Pattern |
|-----------|-------|----------------|
| `current_time` | `CurrentTimeTool` | Time-related queries |
| `date_calculator` | `DateCalculatorTool` | Date math ("3 days from now") |
| `search_memory` | `MemorySearchTool` | "Do you remember…" |
| `get_user_profile` | `GetUserProfileTool` | Profile lookups |
| `get_recent_chat` | `GetRecentChatTool` | Recent conversation context |
| `search_chat_history` | `SearchChatHistoryTool` | Searching past chats |
| `web_search` | `WebSearchTool` | "Search for…", factual queries |

## Adding a New Tool

1. Create a file in `backend/tools/` with a class that extends `BaseTool`.
2. Implement `execute(context: ToolContext, **kwargs) -> ToolResult`.
3. Register it in `__init__.py` default registry.
4. Add trigger pattern in `_pre_execute_tools()` in `chat_stream_router.py`.

## REST API

`backend/api/tools_router.py` — 3 endpoints:

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/tools/execute` | Execute a single tool |
| `POST` | `/api/tools/batch` | Execute multiple tools in sequence |
| `GET` | `/api/tools/list` | List all available tools |

## Pre-Execution

Before LLM generation, both `chat_router.py` and `chat_stream_router.py`
call `_pre_execute_tools()` which pattern-matches the user message:

- Time queries → auto-run `CurrentTimeTool`
- Memory queries → auto-run `MemorySearchTool`
- Search queries → auto-run `WebSearchTool`

Results are injected into the user message context before the LLM sees it.

## Voice Integration

`frontend/js/voice_session.js` calls `POST /api/tools/execute` first,
falling back to client-side `_executeToolClientSide()` if the backend
is unreachable. Tool calls are async and executed concurrently.
