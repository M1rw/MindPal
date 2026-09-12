# backend/features/tools/routes.py

"""
HTTP REST endpoints for MindPal tool execution.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.api.dependencies import (
    AuthenticatedRequestContextDep,
    RequestContextDep,
    ServicesDep,
    assert_authenticated,
)
from backend.core.security import sanitize_text
from .base import ToolContext, ToolRegistry
from .calculation import CalculationTool
from .chat_search import ChatSearchTool
from .memory_search import MemorySearchTool
from .time_tool import CurrentTimeTool, DateCalculatorTool
from .web_search import WebSearchTool

router = APIRouter(prefix="/api/tools", tags=["tools"])

MAX_TOOL_NAME_CHARS = 80
_registry: ToolRegistry | None = None


def get_default_registry() -> ToolRegistry:
    global _registry
    if _registry is None:
        _registry = ToolRegistry()
        _registry.register(CurrentTimeTool())
        _registry.register(DateCalculatorTool())
        _registry.register(CalculationTool())
        _registry.register(MemorySearchTool())
        _registry.register(ChatSearchTool())
        _registry.register(WebSearchTool())
    return _registry


class ToolExecuteRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    tool: str = Field(min_length=1, max_length=MAX_TOOL_NAME_CHARS)
    args: dict[str, Any] = Field(default_factory=dict)

    @field_validator("tool", mode="before")
    @classmethod
    def _clean_tool(cls, value: object) -> str:
        return sanitize_text(str(value or ""), MAX_TOOL_NAME_CHARS)

    @field_validator("args", mode="before")
    @classmethod
    def _validate_args(cls, value: object) -> dict[str, Any]:
        if value is None:
            return {}
        if not isinstance(value, dict):
            raise ValueError("args must be an object")
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)
        if len(encoded) > 12_000:
            raise ValueError("tool arguments are too large")
        return value


class ToolBatchRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    calls: list[ToolExecuteRequest] = Field(min_length=1, max_length=5)


@router.post("/execute")
async def execute_tool(
    payload: ToolExecuteRequest,
    services: ServicesDep,
    context: RequestContextDep,
) -> dict[str, Any]:
    assert_authenticated(context)
    await services.rate_limits.consume(
        scope="tools",
        subject=context.session.user_id_hash,
        limit=services.settings.TOOL_RATE_LIMIT_PER_MINUTE,
        window_seconds=60,
    )
    if payload.tool == "web_search":
        await services.rate_limits.consume(
            scope="web_search",
            subject=context.session.user_id_hash,
            limit=services.settings.WEB_SEARCH_RATE_LIMIT_PER_HOUR,
            window_seconds=3600,
        )

    registry = get_default_registry()
    tool_context = ToolContext(
        user_id_hash=context.session.user_id_hash,
        authenticated=context.authenticated,
        locale=context.locale,
        timezone=getattr(context, "timezone", "UTC"),
        request_id=context.request_id,
        services=services,
    )
    result = await registry.execute(payload.tool, payload.args, tool_context)
    return {
        "tool": payload.tool,
        "result": result.to_dict() if result.ok else None,
        "error": result.error,
        "request_id": context.request_id,
    }


@router.post("/batch")
async def execute_tools_batch(
    payload: ToolBatchRequest,
    services: ServicesDep,
    context: RequestContextDep,
) -> dict[str, Any]:
    assert_authenticated(context)
    await services.rate_limits.consume(
        scope="tools",
        subject=context.session.user_id_hash,
        limit=services.settings.TOOL_RATE_LIMIT_PER_MINUTE,
        window_seconds=60,
        amount=len(payload.calls),
    )
    registry = get_default_registry()
    tool_context = ToolContext(
        user_id_hash=context.session.user_id_hash,
        authenticated=context.authenticated,
        locale=context.locale,
        timezone=getattr(context, "timezone", "UTC"),
        request_id=context.request_id,
        services=services,
    )
    results = []
    for call in payload.calls:
        res = await registry.execute(call.tool, call.args, tool_context)
        results.append({
            "tool": call.tool,
            "result": res.to_dict() if res.ok else None,
            "error": res.error,
        })
    return {"results": results, "request_id": context.request_id}


@router.get("/list")
async def list_tools(
    context: AuthenticatedRequestContextDep,
) -> dict[str, Any]:
    assert_authenticated(context)
    registry = get_default_registry()
    return {
        "tools": [
            {
                "name": name,
                "description": registry.get(name).description if registry.get(name) else "",
            }
            for name in registry.tool_names
        ],
        "count": len(registry.tool_names),
        "request_id": context.request_id,
    }


@router.get("/declarations")
async def get_tool_declarations(
    services: ServicesDep,
    context: RequestContextDep,
) -> dict[str, Any]:
    registry = get_default_registry()
    return {"tools": registry.get_declarations()}
