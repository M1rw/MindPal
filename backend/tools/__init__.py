# backend/tools/__init__.py

"""
MindPal Tool Framework.

Provides a unified interface for all tools that MindPal can use — both in
text chat (standard + pro) and voice sessions.

Architecture:
- BaseTool: abstract base class every tool must extend
- ToolResult: standardized return type
- ToolRegistry: central registry that resolves tools by name and provides
  Gemini-compatible function declarations
- ToolContext: per-request context passed to tool execution (user_id, services, etc.)

Tools are server-side only. The frontend calls them via:
- POST /api/tools/execute (REST, for voice WebSocket fallback)
- Inline in chat_router / chat_stream_router (pre-execution before LLM call)
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from backend.core.security import sanitize_text

logger = logging.getLogger(__name__)

MAX_TOOL_NAME_CHARS = 80
MAX_TOOL_OUTPUT_CHARS = 8_000


@dataclass(frozen=True, slots=True)
class ToolResult:
    """Standardized tool execution result."""

    data: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    tool_name: str = ""

    @property
    def ok(self) -> bool:
        return self.error is None

    def to_dict(self) -> dict[str, Any]:
        if self.error:
            return {"error": sanitize_text(self.error, 500)}
        return self.data


@dataclass(slots=True)
class ToolContext:
    """Per-request context passed to tool execution."""

    user_id_hash: str = ""
    authenticated: bool = False
    locale: str = "auto"
    timezone: str = "UTC"
    request_id: str = ""
    services: Any = None  # ServiceContainer — typed as Any to avoid circular import
    chat_history: list[dict[str, str]] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


class BaseTool(ABC):
    """
    Abstract base class for all MindPal tools.

    Subclasses must implement:
    - name: unique tool identifier
    - description: human-readable description for the LLM
    - parameters: JSON Schema for tool parameters
    - execute(): async execution logic
    """

    @property
    @abstractmethod
    def name(self) -> str:
        ...

    @property
    @abstractmethod
    def description(self) -> str:
        ...

    @property
    @abstractmethod
    def parameters(self) -> dict[str, Any]:
        ...

    @abstractmethod
    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        ...

    def get_declaration(self) -> dict[str, Any]:
        """Return Gemini-compatible function declaration."""
        return {
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
        }


class ToolRegistry:
    """
    Central registry for all MindPal tools.

    Usage:
        registry = ToolRegistry()
        registry.register(CurrentTimeTool())
        registry.register(MemorySearchTool())

        # Get Gemini function declarations
        declarations = registry.get_declarations()

        # Execute a tool by name
        result = await registry.execute("current_time", {}, context)
    """

    def __init__(self) -> None:
        self._tools: dict[str, BaseTool] = {}

    def register(self, tool: BaseTool) -> None:
        """Register a tool. Raises ValueError on duplicate names."""
        name = sanitize_text(tool.name, MAX_TOOL_NAME_CHARS)
        if name in self._tools:
            raise ValueError(f"Tool already registered: {name}")
        self._tools[name] = tool

    def get(self, name: str) -> BaseTool | None:
        """Get a tool by name."""
        return self._tools.get(sanitize_text(name, MAX_TOOL_NAME_CHARS))

    @property
    def tool_names(self) -> list[str]:
        """List all registered tool names."""
        return list(self._tools.keys())

    def get_declarations(self) -> list[dict[str, Any]]:
        """Return all tool declarations in Gemini function_declarations format."""
        return [tool.get_declaration() for tool in self._tools.values()]

    def get_tool_descriptions_prompt(self) -> str:
        """Return a human-readable summary of tools for system prompt injection."""
        if not self._tools:
            return ""

        lines = ["Available tools:"]
        for tool in self._tools.values():
            lines.append(f"- {tool.name}: {tool.description}")
        return "\n".join(lines)

    async def execute(
        self,
        name: str,
        args: dict[str, Any],
        context: ToolContext,
    ) -> ToolResult:
        """Execute a tool by name."""
        clean_name = sanitize_text(name, MAX_TOOL_NAME_CHARS)
        tool = self._tools.get(clean_name)

        if tool is None:
            return ToolResult(error=f"Unknown tool: {clean_name}", tool_name=clean_name)

        try:
            result = await tool.execute(args, context)
            return ToolResult(
                data=result.data,
                error=result.error,
                tool_name=clean_name,
            )
        except Exception as exc:
            logger.warning("Tool %s failed: %s", clean_name, type(exc).__name__)
            return ToolResult(
                error=f"Tool execution failed: {type(exc).__name__}",
                tool_name=clean_name,
            )


def build_default_registry() -> ToolRegistry:
    """
    Build a ToolRegistry with all standard MindPal tools.

    Called once during service container initialization.
    """
    from backend.tools.time_tool import CurrentTimeTool, DateCalculatorTool
    from backend.tools.memory_search_tool import MemorySearchTool, GetUserProfileTool
    from backend.tools.chat_search_tool import GetRecentChatTool, SearchChatHistoryTool
    from backend.tools.web_search_tool import WebSearchTool

    registry = ToolRegistry()
    registry.register(CurrentTimeTool())
    registry.register(DateCalculatorTool())
    registry.register(MemorySearchTool())
    registry.register(GetUserProfileTool())
    registry.register(GetRecentChatTool())
    registry.register(SearchChatHistoryTool())
    registry.register(WebSearchTool())

    return registry


__all__ = [
    "BaseTool",
    "ToolContext",
    "ToolRegistry",
    "ToolResult",
    "build_default_registry",
]
