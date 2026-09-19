# backend/domain/wellness/timeline.py — Coarse mood/event reflection from stored text.
#
# This is not screening, not PHQ-9/GAD-7, and not a per-day happiness score.
# Labels are derived from the person's own words (saved memory atoms + user turns).

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any, Dict, List, Mapping, Optional, Sequence

from backend.domain.safety.classify import crisis_evidence

WELLNESS_DISCLAIMER = (
    "This is a reflection of your words, not a diagnosis. "
    "MindPal is a wellness companion, not a medical service. Take what helps."
)
SOURCE_ACCOUNT = "saved_memory_and_synced_chats"
SOURCE_ACCOUNT_LABEL = "From what you've told MindPal — saved memory and synced chats"
SOURCE_DEVICE = "this_device"
SOURCE_DEVICE_LABEL = (
    "From this device — local chats and guest facts. Sign in to include account memory."
)
CRISIS_NOTE = (
    "Some messages used crisis language. Those are not charted. "
    "If you need help now, use the resources on this page."
)

_MAX_SNIPPET = 80
_MAX_THEMES = 8
_MAX_EVENTS = 8
_MAX_TIMELINE_DAYS = 90
_HIGHLIGHT_MIN_VALENCE_DAYS = 2
_HIGHLIGHT_MIN_HITS_SINGLE_DAY = 3

_HEAVY_WORDS = frozenset(
    {
        "angry",
        "furious",
        "enraged",
        "irritated",
        "resentful",
        "sad",
        "unhappy",
        "miserable",
        "heartbroken",
        "devastated",
        "anxious",
        "worried",
        "panicked",
        "terrified",
        "scared",
        "overwhelmed",
        "exhausted",
        "drained",
        "hopeless",
        "lonely",
        "stressed",
        "depressed",
        "numb",
        "غاضب",
        "حزين",
        "قلق",
        "منهك",
        "وحيد",
    }
)
_LIGHTER_WORDS = frozenset(
    {
        "happy",
        "grateful",
        "thankful",
        "relieved",
        "proud",
        "hopeful",
        "excited",
        "peaceful",
        "calm",
        "joyful",
        "loved",
        "content",
        "سعيد",
        "ممتن",
        "مرتاح",
        "هادئ",
        "فخور",
    }
)
_HEAVY_PHRASES = (
    "burned out",
    "burnt out",
    "fed up",
    "can't sleep",
    "cannot sleep",
    "couldn't sleep",
    "could not sleep",
    "feel stuck",
    "feeling stuck",
    "i feel overwhelmed",
    "i'm feeling overwhelmed",
    "i am feeling overwhelmed",
    "i'm feeling anxious",
    "i am feeling anxious",
    "i feel anxious",
    "i feel angry",
    "i'm angry",
    "i am angry",
    "i feel sad",
    "i'm sad",
    "i am sad",
    "hate my job",
    "so tired of",
)
_LIGHTER_PHRASES = (
    "feeling better",
    "felt better",
    "a bit better",
    "so happy",
    "i'm happy",
    "i am happy",
    "i feel happy",
    "i'm grateful",
    "i am grateful",
    "feeling hopeful",
    "feeling calm",
    "feeling proud",
    "good day",
    "great day",
)

_THEME_SPECS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("sleep", "Sleep", ("sleep", "sleeping", "slept", "asleep", "insomnia", "nightmare", "awake at")),
    ("work", "Work", ("work", "job", "boss", "coworker", "career", "deadline", "office")),
    ("relationship", "Relationship", ("partner", "relationship", "boyfriend", "girlfriend", "spouse", "marriage", "breakup", "broke up")),
    ("family", "Family", ("family", "mom", "dad", "mother", "father", "parent", "sister", "brother", "kids", "children")),
    ("health", "Health & body", ("health", "sick", "pain", "doctor", "hospital", "appetite", "energy")),
    ("school", "School", ("school", "exam", "study", "homework", "university", "college", "class")),
    ("money", "Money", ("money", "rent", "bills", "debt", "paycheck", "i'm broke", "im broke")),
)

_EVENT_SPECS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("new_job", "Started a new job", ("got a new job", "started a new job", "landed a new job", "new job")),
    ("lost_job", "Lost a job", ("lost my job", "got laid off", "was fired", "got fired")),
    ("moved", "Moved", ("i moved", "we moved", "moving to", "moved to", "moved into", "moved out")),
    ("broke_up", "Breakup", ("broke up", "we broke up", "breakup", "break up")),
    ("graduated", "Graduated", ("i graduated", "graduated from")),
    ("got_married", "Got married", ("got married", "we got married")),
)

_NEGATION_WINDOW = 28


@dataclass
class _DayAgg:
    date: str
    turn_count: int = 0
    heavy: int = 0
    lighter: int = 0
    heavy_snippet: str = ""
    lighter_snippet: str = ""

    @property
    def valence(self) -> Optional[str]:
        if self.heavy and self.lighter:
            return "mixed"
        if self.heavy:
            return "heavy"
        if self.lighter:
            return "lighter"
        return None


@dataclass
class _ThemeAgg:
    id: str
    label: str
    mentions: int = 0
    last_seen: Optional[str] = None
    snippet: str = ""
    from_memory: bool = False


@dataclass
class _EventAgg:
    id: str
    label: str
    date: Optional[str] = None
    snippet: str = ""
    from_memory: bool = False


def build_wellness_timeline(
    *,
    atoms: Sequence[Any],
    turns: Sequence[Mapping[str, Any]],
    source: str,
    source_label: str,
) -> Dict[str, Any]:
    """Derive a coarse wellness overview from stored atoms and user turns only."""
    crisis_noted = False
    days: dict[str, _DayAgg] = {}
    themes: dict[str, _ThemeAgg] = {
        theme_id: _ThemeAgg(id=theme_id, label=label) for theme_id, label, _ in _THEME_SPECS
    }
    events: dict[str, _EventAgg] = {
        event_id: _EventAgg(id=event_id, label=label) for event_id, label, _ in _EVENT_SPECS
    }

    for atom in atoms:
        category, value = _atom_fields(atom)
        if not value:
            continue
        lowered = value.lower()
        if crisis_evidence(value):
            crisis_noted = True
            continue
        _apply_themes(themes, lowered, value, day=None, from_memory=True)
        _apply_events(events, lowered, value, day=None, from_memory=True)
        _theme_from_atom_category(themes, category, value)

    for turn in turns:
        content = str(turn.get("content") or turn.get("text") or "").strip()
        if not content:
            continue
        day = _day_from_timestamp(turn.get("timestamp") or turn.get("created_at") or turn.get("createdAt"))
        if crisis_evidence(content):
            crisis_noted = True
            continue
        lowered = content.lower()
        if day:
            agg = days.setdefault(day, _DayAgg(date=day))
            agg.turn_count += 1
            heavy_hits, heavy_snip = _count_valence(lowered, content, _HEAVY_WORDS, _HEAVY_PHRASES)
            light_hits, light_snip = _count_valence(lowered, content, _LIGHTER_WORDS, _LIGHTER_PHRASES)
            agg.heavy += heavy_hits
            agg.lighter += light_hits
            if heavy_snip and not agg.heavy_snippet:
                agg.heavy_snippet = heavy_snip
            if light_snip and not agg.lighter_snippet:
                agg.lighter_snippet = light_snip
        _apply_themes(themes, lowered, content, day=day, from_memory=False)
        _apply_events(events, lowered, content, day=day, from_memory=False)

    ordered_days = sorted(days.values(), key=lambda item: item.date)[-_MAX_TIMELINE_DAYS:]
    activity = [{"date": item.date, "turn_count": item.turn_count} for item in ordered_days if item.turn_count]
    mood_timeline = [_mood_point(item) for item in ordered_days if item.valence]
    highlights = _highlights(ordered_days)
    theme_list = _theme_payload(themes)
    event_list = _event_payload(events)

    empty = not activity and not mood_timeline and not theme_list and not event_list
    range_payload = _range_payload(ordered_days, theme_list, event_list)

    return {
        "source": source,
        "source_label": source_label,
        "disclaimer": WELLNESS_DISCLAIMER,
        "range": range_payload,
        "activity": activity,
        "mood_timeline": mood_timeline,
        "highlights": highlights,
        "themes": theme_list,
        "events": event_list,
        "crisis_note": CRISIS_NOTE if crisis_noted else None,
        "empty": empty,
        "empty_reason": "no_saved_signals" if empty else None,
    }


def empty_wellness_timeline(*, source: str, source_label: str) -> Dict[str, Any]:
    return {
        "source": source,
        "source_label": source_label,
        "disclaimer": WELLNESS_DISCLAIMER,
        "range": None,
        "activity": [],
        "mood_timeline": [],
        "highlights": {"heavier_day": None, "lighter_day": None},
        "themes": [],
        "events": [],
        "crisis_note": None,
        "empty": True,
        "empty_reason": "no_saved_signals",
    }


def _atom_fields(atom: Any) -> tuple[str, str]:
    if isinstance(atom, Mapping):
        category = str(atom.get("category") or atom.get("type") or "").strip()
        value = str(atom.get("value") or atom.get("text") or atom.get("display_value") or "").strip()
        return category, value
    category = str(getattr(atom, "category", "") or "").strip()
    value = str(getattr(atom, "value", "") or "").strip()
    return category, value


def _day_from_timestamp(raw: Any) -> Optional[str]:
    if not isinstance(raw, str) or len(raw) < 10:
        return None
    stamp = raw[:10]
    try:
        date.fromisoformat(stamp)
    except ValueError:
        return None
    return stamp


def _count_valence(
    lowered: str,
    original: str,
    words: frozenset[str],
    phrases: tuple[str, ...],
) -> tuple[int, str]:
    hits = 0
    snippet = ""
    for phrase in phrases:
        start = 0
        while True:
            index = lowered.find(phrase, start)
            if index < 0:
                break
            if _negated(lowered, index):
                start = index + len(phrase)
                continue
            hits += 1
            if not snippet:
                snippet = _snippet(original, index, index + len(phrase))
            start = index + len(phrase)
    for word in words:
        start = 0
        token = word.lower()
        while True:
            index = _find_word(lowered, token, start)
            if index < 0:
                break
            if _negated(lowered, index):
                start = index + len(token)
                continue
            hits += 1
            if not snippet:
                snippet = _snippet(original, index, index + len(token))
            start = index + len(token)
    return hits, snippet


def _find_word(text: str, word: str, start: int) -> int:
    index = start
    while True:
        found = text.find(word, index)
        if found < 0:
            return -1
        before = text[found - 1] if found > 0 else " "
        after_index = found + len(word)
        after = text[after_index] if after_index < len(text) else " "
        if not before.isalnum() and not after.isalnum():
            return found
        index = found + 1


def _negated(text: str, index: int) -> bool:
    window = text[max(0, index - _NEGATION_WINDOW) : index]
    return any(token in window for token in (" not ", " never ", " don't ", " dont ", " didn't ", " didnt ", " no "))


def _snippet(text: str, start: int, end: int) -> str:
    cleaned = " ".join((text or "").split())
    if not cleaned:
        return ""
    if crisis_evidence(cleaned):
        return ""
    if len(cleaned) <= _MAX_SNIPPET:
        return cleaned
    # Prefer a window around the match, then clip on a word boundary.
    left = max(0, start - 24)
    right = min(len(text), end + 48)
    chunk = " ".join(text[left:right].split())
    if len(chunk) > _MAX_SNIPPET:
        chunk = chunk[:_MAX_SNIPPET].rsplit(" ", 1)[0].strip()
    if left > 0 and not chunk.startswith(("I ", "i ", "My ", "We ")):
        chunk = f"…{chunk}"
    if not chunk:
        chunk = cleaned[:_MAX_SNIPPET].rsplit(" ", 1)[0].strip()
    return chunk


def _apply_themes(
    themes: dict[str, _ThemeAgg],
    lowered: str,
    original: str,
    *,
    day: Optional[str],
    from_memory: bool,
) -> None:
    for theme_id, _label, needles in _THEME_SPECS:
        if not any(_contains_needle(lowered, needle) for needle in needles):
            continue
        item = themes[theme_id]
        item.mentions += 1
        if from_memory:
            item.from_memory = True
        if day and (item.last_seen is None or day > item.last_seen):
            item.last_seen = day
        if not item.snippet:
            item.snippet = _snippet(original, 0, min(len(original), 40))


def _theme_from_atom_category(themes: dict[str, _ThemeAgg], category: str, value: str) -> None:
    lowered = (category or "").lower().replace(" ", "_")
    if lowered in {"relationship_context", "relationship"} and themes["relationship"].mentions == 0:
        themes["relationship"].mentions += 1
        themes["relationship"].from_memory = True
        themes["relationship"].snippet = _snippet(value, 0, len(value))


def _apply_events(
    events: dict[str, _EventAgg],
    lowered: str,
    original: str,
    *,
    day: Optional[str],
    from_memory: bool,
) -> None:
    for event_id, _label, needles in _EVENT_SPECS:
        if not any(_contains_needle(lowered, needle) for needle in needles):
            continue
        item = events[event_id]
        if from_memory:
            item.from_memory = True
        if day and (item.date is None or day > item.date):
            item.date = day
        if not item.snippet:
            item.snippet = _snippet(original, 0, min(len(original), 40))


def _contains_needle(text: str, needle: str) -> bool:
    if " " in needle:
        return needle in text
    return _find_word(text, needle, 0) >= 0


def _mood_point(item: _DayAgg) -> Dict[str, Any]:
    valence = item.valence or "mixed"
    labels = {
        "heavy": "Heavier",
        "mixed": "Mixed",
        "lighter": "Lighter",
    }
    snippet = ""
    if valence == "heavy":
        snippet = item.heavy_snippet
    elif valence == "lighter":
        snippet = item.lighter_snippet
    else:
        snippet = item.heavy_snippet or item.lighter_snippet
    return {
        "date": item.date,
        "valence": valence,
        "label": labels[valence],
        "turn_count": item.turn_count,
        "snippet": snippet or None,
    }


def _highlights(days: Sequence[_DayAgg]) -> Dict[str, Any]:
    valence_days = [item for item in days if item.valence]
    empty = {"heavier_day": None, "lighter_day": None}
    if not valence_days:
        return empty
    total_hits = sum(item.heavy + item.lighter for item in valence_days)
    enough = len(valence_days) >= _HIGHLIGHT_MIN_VALENCE_DAYS or total_hits >= _HIGHLIGHT_MIN_HITS_SINGLE_DAY
    if not enough:
        return empty

    heavy_candidates = [item for item in valence_days if item.heavy > 0]
    light_candidates = [item for item in valence_days if item.lighter > 0]
    heavier = max(heavy_candidates, key=lambda item: (item.heavy, -item.lighter, item.date)) if heavy_candidates else None
    lighter = max(light_candidates, key=lambda item: (item.lighter, -item.heavy, item.date)) if light_candidates else None
    if heavier and lighter and heavier.date == lighter.date:
        if heavier.heavy >= lighter.lighter and len(light_candidates) > 1:
            lighter = max(
                (item for item in light_candidates if item.date != heavier.date),
                key=lambda item: (item.lighter, -item.heavy, item.date),
                default=None,
            )
        elif lighter.lighter > heavier.heavy and len(heavy_candidates) > 1:
            heavier = max(
                (item for item in heavy_candidates if item.date != lighter.date),
                key=lambda item: (item.heavy, -item.lighter, item.date),
                default=None,
            )
        else:
            # Same day holds both signals — don't pretend we know a worst vs lightest day.
            return empty

    return {
        "heavier_day": _highlight_payload(heavier, "heavier") if heavier else None,
        "lighter_day": _highlight_payload(lighter, "lighter") if lighter else None,
    }


def _highlight_payload(item: _DayAgg, kind: str) -> Dict[str, Any]:
    snippet = item.heavy_snippet if kind == "heavier" else item.lighter_snippet
    if not snippet:
        snippet = item.heavy_snippet or item.lighter_snippet
    return {
        "date": item.date,
        "label": "Heavier day" if kind == "heavier" else "Lighter day",
        "valence": item.valence,
        "snippet": snippet or None,
    }


def _theme_payload(themes: dict[str, _ThemeAgg]) -> List[Dict[str, Any]]:
    ranked = sorted(
        (item for item in themes.values() if item.mentions > 0),
        key=lambda item: (-item.mentions, item.last_seen or "", item.id),
    )
    return [
        {
            "id": item.id,
            "label": item.label,
            "mentions": item.mentions,
            "last_seen": item.last_seen,
            "snippet": item.snippet or None,
            "from_memory": item.from_memory,
        }
        for item in ranked[:_MAX_THEMES]
    ]


def _event_payload(events: dict[str, _EventAgg]) -> List[Dict[str, Any]]:
    found = [item for item in events.values() if item.snippet or item.date or item.from_memory]
    found.sort(key=lambda item: item.date or "", reverse=True)
    return [
        {
            "id": item.id,
            "label": item.label,
            "date": item.date,
            "snippet": item.snippet or None,
            "from_memory": item.from_memory,
        }
        for item in found[:_MAX_EVENTS]
        if item.snippet or item.from_memory
    ]


def _range_payload(
    days: Sequence[_DayAgg],
    themes: Sequence[Mapping[str, Any]],
    events: Sequence[Mapping[str, Any]],
) -> Optional[Dict[str, Any]]:
    stamps = [item.date for item in days]
    stamps.extend(str(theme.get("last_seen") or "")[:10] for theme in themes if theme.get("last_seen"))
    stamps.extend(str(event.get("date") or "")[:10] for event in events if event.get("date"))
    parsed: list[date] = []
    for raw in stamps:
        if len(raw) < 10:
            continue
        try:
            parsed.append(date.fromisoformat(raw[:10]))
        except ValueError:
            continue
    if not parsed:
        return None
    start = min(parsed)
    end = max(parsed)
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "days": (end - start).days + 1,
    }
