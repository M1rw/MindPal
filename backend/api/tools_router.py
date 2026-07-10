# backend/api/tools_router.py

"""
REST API for MindPal tool execution.

Provides a unified endpoint for executing tools from both voice sessions
and text chat. Voice sessions use this via HTTP calls from the frontend
instead of running tools client-side.

Security:
- Authentication required for all tool executions
- Tool names are validated against the registry
- Input/output is sanitized
"""

from __future__ import annotations

import json
import logging
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
from backend.tools import ToolContext, build_default_registry

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/tools", tags=["tools"])

MAX_TOOL_NAME_CHARS = 80
MAX_ARG_VALUE_CHARS = 4_000

# Lazy singleton registry
_registry = None


def _get_registry():
    global _registry
    if _registry is None:
        _registry = build_default_registry()
    return _registry


class ToolExecuteRequest(BaseModel):
    """Request to execute a single tool."""

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
        _validate_json_shape(value, depth=0)
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)
        if len(encoded) > 12_000:
            raise ValueError("tool arguments are too large")
        return value


class ToolBatchRequest(BaseModel):
    """Request to execute multiple tools in sequence."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    calls: list[ToolExecuteRequest] = Field(min_length=1, max_length=5)


@router.post("/execute")
async def execute_tool(
    payload: ToolExecuteRequest,
    services: ServicesDep,
    context: RequestContextDep,
) -> dict[str, Any]:
    """
    Execute a single tool by name.

    Used by voice sessions and text chat for tool calls.
    Requires authentication.
    """
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

    registry = _get_registry()
    tool_context = _build_tool_context(context, services)

    result = await registry.execute(payload.tool, payload.args, tool_context)

    if not result.ok:
        return {
            "tool": payload.tool,
            "error": result.error,
            "request_id": context.request_id,
        }

    return {
        "tool": payload.tool,
        "result": result.to_dict(),
        "request_id": context.request_id,
    }


@router.post("/batch")
async def execute_tools_batch(
    payload: ToolBatchRequest,
    services: ServicesDep,
    context: RequestContextDep,
) -> dict[str, Any]:
    """
    Execute multiple tools in sequence.

    Used for agent chain pre-execution (time + memory + search in one call).
    Requires authentication.
    """
    assert_authenticated(context)
    await services.rate_limits.consume(
        scope="tools",
        subject=context.session.user_id_hash,
        limit=services.settings.TOOL_RATE_LIMIT_PER_MINUTE,
        window_seconds=60,
        amount=len(payload.calls),
    )
    web_calls = sum(1 for call in payload.calls if call.tool == "web_search")
    if web_calls:
        await services.rate_limits.consume(
            scope="web_search",
            subject=context.session.user_id_hash,
            limit=services.settings.WEB_SEARCH_RATE_LIMIT_PER_HOUR,
            window_seconds=3600,
            amount=web_calls,
        )

    registry = _get_registry()
    tool_context = _build_tool_context(context, services)

    results: list[dict[str, Any]] = []

    for call in payload.calls:
        result = await registry.execute(call.tool, call.args, tool_context)
        results.append({
            "tool": call.tool,
            "result": result.to_dict() if result.ok else None,
            "error": result.error,
        })

    return {
        "results": results,
        "request_id": context.request_id,
    }


@router.get("/list")
async def list_tools(
    context: AuthenticatedRequestContextDep,
) -> dict[str, Any]:
    """List available tools for an authenticated MindPal client."""
    assert_authenticated(context)
    registry = _get_registry()

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


def _build_tool_context(context: Any, services: Any) -> ToolContext:
    """Build a ToolContext from the request context and services."""
    return ToolContext(
        user_id_hash=context.session.user_id_hash,
        authenticated=context.session.authenticated,
        locale=context.locale,
        timezone="UTC",  # Frontend can send timezone via header in the future
        request_id=context.request_id,
        services=services,
    )


def _validate_json_shape(value: Any, *, depth: int) -> None:
    if depth > 5:
        raise ValueError("tool arguments are nested too deeply")
    if isinstance(value, dict):
        if len(value) > 50:
            raise ValueError("too many tool argument fields")
        for key, item in value.items():
            if len(str(key)) > 120:
                raise ValueError("tool argument key is too long")
            _validate_json_shape(item, depth=depth + 1)
    elif isinstance(value, list):
        if len(value) > 100:
            raise ValueError("tool argument list is too large")
        for item in value:
            _validate_json_shape(item, depth=depth + 1)
    elif isinstance(value, str) and len(value) > MAX_ARG_VALUE_CHARS:
        raise ValueError("tool argument value is too long")
