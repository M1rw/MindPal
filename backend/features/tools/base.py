# backend/features/tools/base.py

"""
Base abstractions, execution context, result contracts, and registry for MindPal tools.
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
    services: Any = None
    chat_history: list[dict[str, str]] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


class BaseTool(ABC):
    """Abstract base class for all MindPal tools."""

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

    def get_anthropic_declaration(self) -> dict[str, Any]:
        """Return Anthropic-compatible tool declaration."""
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.parameters,
        }

    def get_openai_declaration(self) -> dict[str, Any]:
        """Return OpenAI-compatible tool declaration."""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


class ToolRegistry:
    """Central registry of available tools."""

    def __init__(self) -> None:
        self._tools: dict[str, BaseTool] = {}

    def register(self, tool: BaseTool) -> None:
        name = sanitize_text(tool.name, MAX_TOOL_NAME_CHARS)
        if not name:
            raise ValueError("Tool name cannot be empty")
        self._tools[name] = tool

    def get(self, name: str) -> BaseTool | None:
        return self._tools.get(sanitize_text(name, MAX_TOOL_NAME_CHARS))

    @property
    def tool_names(self) -> list[str]:
        return list(self._tools.keys())

    def list_tools(self) -> list[BaseTool]:
        return list(self._tools.values())

    def get_declarations(self) -> list[dict[str, Any]]:
        return [tool.get_declaration() for tool in self._tools.values()]

    def get_openai_declarations(self) -> list[dict[str, Any]]:
        return [tool.get_openai_declaration() for tool in self._tools.values()]

    def get_tool_descriptions_prompt(self) -> str:
        lines = ["Available tools:"]
        for tool in self._tools.values():
            lines.append(f"- {tool.name}: {tool.description}")
        return "\n".join(lines)

    async def execute(self, name: str, args: dict[str, Any], context: ToolContext) -> ToolResult:
        tool = self.get(name)
        if tool is None:
            return ToolResult(error=f"Unknown tool: {name}", tool_name=name)
        try:
            result = await tool.execute(args, context)
            return ToolResult(data=result.data, error=result.error, tool_name=name)
        except Exception as exc:
            logger.exception("tool_execution_failed tool=%s request_id=%s", name, context.request_id)
            return ToolResult(error=f"Tool error: {type(exc).__name__}", tool_name=name)
