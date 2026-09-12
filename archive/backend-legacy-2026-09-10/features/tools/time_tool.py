# backend/features/tools/time_tool.py

"""
Timezone-aware time and date tools for MindPal.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, available_timezones

from backend.core.security import sanitize_text
from .base import BaseTool, ToolContext, ToolResult

_SAFE_TIMEZONES = frozenset(available_timezones())


def resolve_tz(tz_name: str) -> timezone | ZoneInfo:
    """Safely resolve a timezone name, falling back to UTC."""
    cleaned = sanitize_text(tz_name or "UTC", 80).strip()
    if not cleaned or cleaned.upper() == "UTC":
        return UTC
    if cleaned in _SAFE_TIMEZONES:
        return ZoneInfo(cleaned)
    cleaned_upper = cleaned.upper().replace("UTC", "").replace("GMT", "").strip()
    if cleaned_upper:
        try:
            sign = -1 if cleaned_upper.startswith("-") else 1
            if cleaned_upper.startswith(("-", "+")):
                cleaned_upper = cleaned_upper[1:]
            parts = cleaned_upper.split(":")
            hours = int(parts[0])
            minutes = int(parts[1]) if len(parts) > 1 else 0
            return timezone(timedelta(hours=sign * hours, minutes=sign * minutes))
        except (ValueError, IndexError):
            pass
    return UTC


class CurrentTimeTool(BaseTool):
    """Returns current date, time, day of week in UTC and user's local timezone."""

    @property
    def name(self) -> str:
        return "current_time"

    @property
    def description(self) -> str:
        return (
            "Get the current date and time in both UTC and the user's local timezone. "
            "Use this when the user asks about time, date, day of week, or temporal context."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {"type": "OBJECT", "properties": {}}

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        now_utc = datetime.now(UTC)
        user_tz = resolve_tz(context.timezone)
        now_local = now_utc.astimezone(user_tz)

        return ToolResult(data={
            "utc": {
                "datetime": now_utc.strftime("%Y-%m-%d %H:%M:%S UTC"),
                "date": now_utc.strftime("%Y-%m-%d"),
                "time": now_utc.strftime("%H:%M:%S"),
                "day_of_week": now_utc.strftime("%A"),
                "iso": now_utc.isoformat(),
            },
            "local": {
                "datetime": now_local.strftime("%Y-%m-%d %H:%M:%S"),
                "date": now_local.strftime("%Y-%m-%d"),
                "time": now_local.strftime("%H:%M:%S"),
                "day_of_week": now_local.strftime("%A"),
                "timezone": str(user_tz),
                "iso": now_local.isoformat(),
            },
            "unix_timestamp": int(now_utc.timestamp()),
        })


class DateCalculatorTool(BaseTool):
    """Calculates relative dates: days until, days since, offset calculations."""

    @property
    def name(self) -> str:
        return "date_calculator"

    @property
    def description(self) -> str:
        return "Calculate date differences or offsets (e.g. 'how many days until date X' or 'what date is 45 days from today')."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "OBJECT",
            "properties": {
                "target_date": {
                    "type": "STRING",
                    "description": "ISO date string (YYYY-MM-DD)",
                },
                "offset_days": {
                    "type": "INTEGER",
                    "description": "Number of days to add (positive) or subtract (negative)",
                },
            },
        }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        now = datetime.now(UTC)
        target_str = sanitize_text(str(args.get("target_date") or ""), 50).strip()
        offset = args.get("offset_days")

        if target_str:
            try:
                target_dt = datetime.fromisoformat(target_str).replace(tzinfo=UTC)
                diff = (target_dt - now).days
                return ToolResult(data={
                    "target_date": target_str,
                    "days_difference": diff,
                    "is_past": diff < 0,
                    "is_future": diff > 0,
                    "is_today": diff == 0,
                })
            except Exception:
                return ToolResult(error="Invalid target date format. Expected YYYY-MM-DD.")

        if offset is not None:
            try:
                offset_int = int(offset)
                result_dt = now + timedelta(days=offset_int)
                return ToolResult(data={
                    "offset_days": offset_int,
                    "result_date": result_dt.strftime("%Y-%m-%d"),
                    "result_day": result_dt.strftime("%A"),
                })
            except (ValueError, TypeError):
                return ToolResult(error="offset_days must be an integer")

        return ToolResult(error="Provide either target_date or offset_days")
