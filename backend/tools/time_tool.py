# backend/tools/time_tool.py

"""
Time awareness tools for MindPal.

Gives MindPal access to current time, date, and date calculations
so it never has to guess or say "I don't know what time it is."
"""

from __future__ import annotations

import calendar
from datetime import UTC, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, available_timezones

from backend.core.security import sanitize_text
from backend.tools import BaseTool, ToolContext, ToolResult


_SAFE_TIMEZONES = frozenset(available_timezones())


def _resolve_tz(tz_name: str) -> timezone | ZoneInfo:
    """Safely resolve a timezone name, falling back to UTC."""
    cleaned = sanitize_text(tz_name or "UTC", 80).strip()
    if not cleaned or cleaned.upper() == "UTC":
        return UTC
    if cleaned in _SAFE_TIMEZONES:
        return ZoneInfo(cleaned)
    # Try offset format like "+03:00" or "UTC+3"
    cleaned_upper = cleaned.upper().replace("UTC", "").replace("GMT", "").strip()
    if cleaned_upper:
        try:
            sign = 1
            if cleaned_upper.startswith("-"):
                sign = -1
                cleaned_upper = cleaned_upper[1:]
            elif cleaned_upper.startswith("+"):
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
            "Use this when the user asks about time, date, day of week, or when you need "
            "temporal context for your response."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {"type": "OBJECT", "properties": {}}

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        now_utc = datetime.now(UTC)
        user_tz = _resolve_tz(context.timezone)
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
    """Calculates relative dates: how long ago, days until, date math."""

    @property
    def name(self) -> str:
        return "date_calculator"

    @property
    def description(self) -> str:
        return (
            "Calculate date differences — 'how long ago was X?', 'how many days until Y?', "
            "'what date is N days from now?'. Provide a date string and operation."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "OBJECT",
            "properties": {
                "operation": {
                    "type": "STRING",
                    "description": "One of: 'days_since' (how many days since a date), "
                                   "'days_until' (how many days until a date), "
                                   "'add_days' (what date is N days from now)",
                },
                "date": {
                    "type": "STRING",
                    "description": "Date in YYYY-MM-DD format (for days_since/days_until)",
                },
                "days": {
                    "type": "INTEGER",
                    "description": "Number of days (for add_days operation)",
                },
            },
            "required": ["operation"],
        }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        operation = sanitize_text(str(args.get("operation", "")), 40).lower()
        date_str = sanitize_text(str(args.get("date", "")), 20)
        days = int(args.get("days", 0) or 0)

        user_tz = _resolve_tz(context.timezone)
        now = datetime.now(UTC).astimezone(user_tz)
        today = now.date()

        if operation == "add_days":
            target = today + timedelta(days=days)
            return ToolResult(data={
                "result_date": target.isoformat(),
                "day_of_week": target.strftime("%A"),
                "description": f"{days} days from {today.isoformat()} is {target.isoformat()} ({target.strftime('%A')})",
            })

        # Parse target date
        target_date = None
        if date_str:
            for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%Y/%m/%d"):
                try:
                    target_date = datetime.strptime(date_str, fmt).date()
                    break
                except ValueError:
                    continue

        if target_date is None:
            return ToolResult(error="Could not parse date. Use YYYY-MM-DD format.")

        delta = today - target_date
        abs_days = abs(delta.days)
        years = abs_days // 365
        months = (abs_days % 365) // 30
        remaining_days = (abs_days % 365) % 30

        human_parts: list[str] = []
        if years:
            human_parts.append(f"{years} year{'s' if years != 1 else ''}")
        if months:
            human_parts.append(f"{months} month{'s' if months != 1 else ''}")
        if remaining_days or not human_parts:
            human_parts.append(f"{remaining_days} day{'s' if remaining_days != 1 else ''}")
        human_readable = ", ".join(human_parts)

        if operation == "days_since":
            return ToolResult(data={
                "days": delta.days,
                "human_readable": human_readable + " ago" if delta.days >= 0 else human_readable + " from now",
                "target_date": target_date.isoformat(),
                "day_of_week": target_date.strftime("%A"),
            })

        if operation == "days_until":
            until = -delta.days
            return ToolResult(data={
                "days": until,
                "human_readable": human_readable + " from now" if until >= 0 else human_readable + " ago",
                "target_date": target_date.isoformat(),
                "day_of_week": target_date.strftime("%A"),
            })

        return ToolResult(error=f"Unknown operation: {operation}. Use: days_since, days_until, add_days")
