"""Client context tools for time and permission-granted location."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping, Optional
from zoneinfo import ZoneInfo


TOOL_CATALOG_PATH = Path(__file__).with_name("tools.json")


def load_tool_catalog() -> list[dict[str, Any]]:
    with TOOL_CATALOG_PATH.open(encoding="utf-8") as catalog_file:
        payload = json.load(catalog_file)
    tools = payload.get("tools") if isinstance(payload, dict) else None
    if not isinstance(tools, list):
        raise ValueError("tools.json must contain a tools list")
    return [tool for tool in tools if isinstance(tool, dict) and isinstance(tool.get("name"), str)]


@dataclass(frozen=True)
class ToolContext:
    timezone: str
    locale: Optional[str] = None
    location: Optional[Mapping[str, Any]] = None


class ClientContextTools:
    """Build factual client context; the model decides when it is relevant."""

    @staticmethod
    def current_time(context: ToolContext) -> str:
        local_now = datetime.now(ZoneInfo(context.timezone))
        return (
            f"Current local date and time: {local_now.strftime('%A, %B %d, %Y at %I:%M %p')} "
            f"({context.timezone})."
        )

    @staticmethod
    def location(context: ToolContext) -> str:
        location = context.location or {}
        latitude = location.get("latitude")
        longitude = location.get("longitude")
        if not isinstance(latitude, (int, float)) or not isinstance(longitude, (int, float)):
            return "No precise location was shared by the user."
        return (
            f"Approximate user coordinates: {latitude:.4f}, {longitude:.4f}. "
            "Do not infer or state an exact address."
        )

    @classmethod
    def system_note(cls, context: ToolContext) -> str:
        catalog = {tool["name"]: tool for tool in load_tool_catalog()}
        parts = [
            "Available client-context tools. Decide from the user's request whether their output is relevant."
        ]
        current_time = catalog.get("current_time", {})
        parts.append(
            f"- current_time: {current_time.get('description', 'Current local date and time.')} "
            f"Result: {cls.current_time(context)}"
        )
        if context.location:
            user_location = catalog.get("user_location", {})
            parts.append(
                f"- user_location: {user_location.get('description', 'Approximate shared location.')} "
                f"Result: {cls.location(context)}"
            )
        usage_lines = []
        for tool in catalog.values():
            when_used = tool.get("when_used")
            if isinstance(when_used, list):
                usage_lines.extend(f"  - {item}" for item in when_used if isinstance(item, str))
        if usage_lines:
            parts.append("Use a tool when the request matches one of these cases:\n" + "\n".join(usage_lines))
        parts.append(
            "Do not claim that local time is inaccessible when current_time is available."
        )
        return "\n".join(parts)


def build_tool_context(raw: Optional[Mapping[str, Any]]) -> Optional[ToolContext]:
    if not raw:
        return None
    timezone = raw.get("timezone")
    if not isinstance(timezone, str) or not timezone:
        return None
    try:
        ZoneInfo(timezone)
    except (KeyError, ValueError):
        return None
    location = raw.get("location")
    return ToolContext(
        timezone=timezone,
        locale=raw.get("locale") if isinstance(raw.get("locale"), str) else None,
        location=location if isinstance(location, Mapping) else None,
    )
