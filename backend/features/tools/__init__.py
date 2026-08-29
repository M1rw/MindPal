# backend/features/tools/__init__.py

"""
Tools feature public exports and registry factories.
"""

from .base import BaseTool, ToolContext, ToolRegistry, ToolResult
from .calculation import CalculationTool
from .chat_search import ChatSearchTool
from .memory_search import MemorySearchTool
from .routes import get_default_registry, router
from .time_tool import CurrentTimeTool, DateCalculatorTool, resolve_tz
from .web_search import WebSearchTool


def build_default_registry() -> ToolRegistry:
    """Factory function for backward-compatible registry construction."""
    return get_default_registry()


__all__ = [
    "BaseTool",
    "CalculationTool",
    "ChatSearchTool",
    "CurrentTimeTool",
    "DateCalculatorTool",
    "MemorySearchTool",
    "ToolContext",
    "ToolRegistry",
    "ToolResult",
    "WebSearchTool",
    "build_default_registry",
    "get_default_registry",
    "resolve_tz",
    "router",
]
