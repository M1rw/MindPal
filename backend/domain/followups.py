"""Which follow-up questions MindPal can ask today.

Open threads come from the memory summary ("How did the Friday exam go?").
Some carry a date to ask after (the day after the exam). Asking before then
is wrong ("how did it go?" about something that hasn't happened), and a
question about something weeks ago is stale. So:

  * undated threads can be asked any time (after the greeting's own gap rules);
  * dated ones only from their day, for a week;
  * dated ones that just came due go first: they are the reason to reach out,
    and the only ones a notification is ever sent for.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any, List, Optional

STALE_AFTER_DAYS = 7


def local_today(tz_offset_minutes: int, now: Optional[datetime] = None) -> date:
    """The person's date. `tz_offset_minutes` is minutes east of UTC (UTC+3 is 180)."""
    current = now or datetime.now(timezone.utc)
    return (current + timedelta(minutes=tz_offset_minutes)).date()


def _after(graph: Any, question: str) -> Optional[date]:
    raw = (getattr(graph, "thread_after", None) or {}).get(question)
    try:
        return date.fromisoformat(raw) if raw else None
    except ValueError:
        return None


def due_threads(graph: Any, today: date) -> List[str]:
    """Dated threads whose day has come, within the last week: worth reaching out for."""
    out: List[str] = []
    for question in getattr(graph, "open_threads", None) or []:
        day = _after(graph, question)
        if day is not None and day <= today < day + timedelta(days=STALE_AFTER_DAYS):
            out.append(question)
    return out


def askable_threads(graph: Any, today: date) -> List[str]:
    """Threads the greeting may ask today, due ones first; never a future or stale dated one."""
    due = due_threads(graph, today)
    undated = [q for q in getattr(graph, "open_threads", None) or [] if _after(graph, q) is None]
    return due + [q for q in undated if q not in due]
