# backend/domain/memory/graph.py — Memory Graph Domain

from __future__ import annotations

import dataclasses
import math
import time

from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence

from backend.configs.runtime import domain_limits_config
from backend.configs.runtime import behavior_config
from backend.infra.store.store import get_store

_MEMORY_BEHAVIOR = behavior_config()["memory_graph"]
_PLACEHOLDER_SUMMARIES = frozenset(_MEMORY_BEHAVIOR["placeholder_summaries"])
_PLACEHOLDER_NAMES = frozenset(_MEMORY_BEHAVIOR["placeholder_names"])
_INACTIVE_STATUSES = frozenset(_MEMORY_BEHAVIOR["inactive_statuses"])
_MEMORY_LIMITS = domain_limits_config()["memory_graph"]
_MAX_ATOMS = int(_MEMORY_LIMITS["max_atoms"])
_MAX_SUMMARY_CHARS = int(_MEMORY_LIMITS["max_summary_chars"])
_MAX_PROMPT_CHARS = int(_MEMORY_LIMITS["max_prompt_chars"])
_MAX_RECEIPT_TEXT = int(_MEMORY_LIMITS["max_receipt_text"])
_MAX_ATOM_VALUE_CHARS = int(_MEMORY_LIMITS["max_atom_value_chars"])
_REBUILD_ATOMS = int(_MEMORY_LIMITS["rebuild_atoms"])

# Public names for the HTTP layer, so the PUT path enforces the same ceilings the
# merge path does instead of inventing its own.
MAX_ATOMS = _MAX_ATOMS
MAX_SUMMARY_CHARS = _MAX_SUMMARY_CHARS
MAX_ATOM_VALUE_CHARS = _MAX_ATOM_VALUE_CHARS
_PROMPT_PREAMBLE = _MEMORY_BEHAVIOR["prompt_preamble"]


@dataclass
class MemoryAtom:
    id: str
    category: str
    value: str
    confidence: float = 1.0
    # Reinforcement: how often the person has brought this up, and when.
    mentions: int = 1
    first_seen: float = 0.0
    last_seen: float = 0.0


# Salience decides what stays when memory is full and what the model sees first.
# A fact that keeps coming up, or came up recently, matters more than one
# mentioned once months ago. Identity facts (their name) are pinned.
_SALIENCE_HALF_LIFE_S = 45 * 24 * 3600
_PINNED_CATEGORIES = frozenset({"profile", "identity"})


def atom_salience(atom: "MemoryAtom", *, now: Optional[float] = None) -> float:
    current = time.time() if now is None else now
    seen = atom.last_seen or atom.first_seen
    age = max(0.0, current - seen) if seen else _SALIENCE_HALF_LIFE_S
    recency = 0.5 ** (age / _SALIENCE_HALF_LIFE_S)
    reinforcement = 1.0 + math.log1p(max(0, atom.mentions - 1))
    pinned = 10.0 if (atom.category or "").lower() in _PINNED_CATEGORIES else 0.0
    return pinned + max(0.05, min(1.0, atom.confidence)) * reinforcement * (0.35 + 0.65 * recency)


def rank_atoms(atoms: Sequence["MemoryAtom"], *, now: Optional[float] = None) -> List["MemoryAtom"]:
    # Ties go to the most recently seen fact, then to the later position (newer
    # merges are appended), so a full memory still takes new facts even when the
    # clock is too coarse to tell two timestamps apart.
    ranked = sorted(
        enumerate(atoms),
        key=lambda item: (round(atom_salience(item[1], now=now), 6), item[1].last_seen or item[1].first_seen, item[0]),
        reverse=True,
    )
    return [atom for _index, atom in ranked]


@dataclass
class MemoryGraph:
    user_id_hash: str
    summary: str = ""
    atoms: List[MemoryAtom] = field(default_factory=list)
    # True when `summary` was generated from the atoms rather than written by the
    # person. Generated summaries are refreshed on every merge and are not sent to
    # the model separately, because they only restate the atoms it already gets.
    summary_auto: bool = False
    # AI-written running summary built from conversation digests and facts by
    # backend.domain.memory.consolidation. Separate from `summary` so a summary
    # the person wrote themselves is never overwritten.
    narrative: str = ""
    narrative_at: float = 0.0
    open_threads: List[str] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class MemoryPrompt:
    text: str = ""
    atom_count: int = 0
    has_summary: bool = False


def honest_summary(value: Any) -> str:
    text = str(value or "").strip()
    if not text or text.lower() in _PLACEHOLDER_SUMMARIES:
        return ""
    return text


def atom_from_mapping(raw: Any) -> Optional[MemoryAtom]:
    if not isinstance(raw, dict):
        return None
    status = str(raw.get("status") or "active").strip().lower()
    if status in _INACTIVE_STATUSES:
        return None
    value = str(raw.get("display_value") or raw.get("value") or raw.get("text") or "").strip()
    key = str(raw.get("key") or "").strip()
    if key and value and key.lower() not in value.lower():
        value = f"{key}: {value}"
    elif not value:
        value = key
    if not value:
        return None
    category = str(raw.get("category") or raw.get("type") or "facts").strip() or "facts"
    atom_id = str(raw.get("id") or "").strip() or f"{category}:{value}"[:80]
    try:
        confidence = float(raw.get("confidence", 1.0))
    except (TypeError, ValueError):
        confidence = 1.0
    return MemoryAtom(
        id=atom_id,
        category=category,
        value=value,
        confidence=confidence,
        mentions=max(1, _as_int(raw.get("mentions"), 1)),
        first_seen=_as_float(raw.get("first_seen")),
        last_seen=_as_float(raw.get("last_seen")),
    )


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_float(value: Any) -> float:
    try:
        return float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0


def format_memory_prompt(
    graph: MemoryGraph,
    *,
    display_name: Optional[str] = None,
    max_atoms: int = _MAX_ATOMS,
    max_chars: int = _MAX_PROMPT_CHARS,
) -> MemoryPrompt:
    """Build a prompt block from stored facts only. Empty memory yields an empty string."""
    summary = "" if graph.summary_auto else honest_summary(graph.summary)
    narrative = " ".join((graph.narrative or "").split())
    preferred_name = _preferred_name(display_name)
    atoms = rank_atoms([atom for atom in graph.atoms if atom.value.strip()])[:max_atoms]

    lines: List[str] = []
    if narrative:
        lines.append(f"Ongoing context (summarized from past conversations; may be outdated): {narrative[:_MAX_SUMMARY_CHARS]}")
        if graph.open_threads:
            lines.append("Open threads worth gently following up: " + "; ".join(graph.open_threads[:3]))
    if summary:
        lines.append(summary[:_MAX_SUMMARY_CHARS].rstrip())
    if preferred_name and preferred_name.lower() not in (summary or "").lower():
        lines.append("Profile:")
        lines.append(f"- Preferred name: {preferred_name}")

    grouped: Dict[str, List[str]] = {}
    for atom in atoms:
        grouped.setdefault(atom.category, []).append(atom.value.strip())
    for category, values in grouped.items():
        lines.append(f"{_category_label(category)}:")
        for value in values:
            lines.append(f"- {value}")

    if not lines:
        return MemoryPrompt()

    body_lines = [_PROMPT_PREAMBLE, ""]
    used = len(body_lines[0]) + 1
    for line in lines:
        extra = len(line) + 1
        if used + extra > max_chars:
            break
        body_lines.append(line)
        used += extra
    if len(body_lines) <= 2:
        return MemoryPrompt()
    return MemoryPrompt(text="\n".join(body_lines), atom_count=len(atoms), has_summary=bool(summary or narrative))


class MemoryGraphService:
    """Loads and saves the durable user memory graph used on chat turns."""

    def __init__(self, store: Any | None = None) -> None:
        self.store = store or get_store()

    def get_memory_graph(self, user_id_hash: str) -> MemoryGraph:
        doc = self.store.get_document("memory_graphs", user_id_hash)
        if not isinstance(doc, dict):
            return MemoryGraph(user_id_hash=user_id_hash)
        payload = doc.get("graph") if isinstance(doc.get("graph"), dict) and not doc.get("atoms") else doc
        if not isinstance(payload, dict):
            return MemoryGraph(user_id_hash=user_id_hash)
        atoms = _atoms_from_payload(payload)
        summary = honest_summary(payload.get("summary") or payload.get("summary_text"))
        auto = payload.get("summary_auto")
        if not isinstance(auto, bool):
            # Documents written before the flag existed: a summary identical to what
            # the atoms would generate was generated.
            auto = bool(summary) and _looks_generated(summary, atoms)
        threads = payload.get("open_threads")
        return MemoryGraph(
            user_id_hash=user_id_hash,
            summary=summary,
            atoms=atoms,
            summary_auto=auto,
            narrative=str(payload.get("narrative") or ""),
            narrative_at=_as_float(payload.get("narrative_at")),
            open_threads=[str(t) for t in threads][:3] if isinstance(threads, list) else [],
        )

    def save_memory_graph(self, graph: MemoryGraph) -> None:
        doc = {
            "user_id_hash": graph.user_id_hash,
            "summary": honest_summary(graph.summary),
            "summary_auto": bool(graph.summary_auto),
            "narrative": graph.narrative,
            "narrative_at": graph.narrative_at,
            "open_threads": list(graph.open_threads[:3]),
            "atoms": [
                {
                    "id": a.id,
                    "category": a.category,
                    "value": a.value,
                    "confidence": round(float(a.confidence), 3),
                    "mentions": int(a.mentions),
                    "first_seen": a.first_seen,
                    "last_seen": a.last_seen,
                }
                for a in graph.atoms
            ],
        }
        self.store.set_document("memory_graphs", graph.user_id_hash, doc)

    def update_summary(self, user_id_hash: str, new_summary: str) -> MemoryGraph:
        graph = self.get_memory_graph(user_id_hash)
        graph.summary = honest_summary(new_summary)
        graph.summary_auto = False
        self.save_memory_graph(graph)
        return graph

    def rebuild_summary(self, user_id_hash: str) -> MemoryGraph:
        """Recompute the summary from the atoms that are actually stored.

        Deterministic and model-free: it restates saved facts and nothing else.
        With no atoms the summary is cleared rather than left stale, because a
        summary describing memory the account no longer holds is a lie the chat
        prompt would keep repeating.
        """
        graph = self.get_memory_graph(user_id_hash)
        graph.summary = summary_from_atoms(rank_atoms(graph.atoms))
        graph.summary_auto = True
        self.save_memory_graph(graph)
        return graph

    def update_atom(self, user_id_hash: str, atom_id: str, value: str) -> Optional[MemoryGraph]:
        """Replace the stored text for one atom. Empty text is rejected by the caller."""
        text = clip_atom_value(value)
        if not text:
            return None
        key = str(atom_id or "").strip()
        if not key:
            return None
        graph = self.get_memory_graph(user_id_hash)
        next_atoms: List[MemoryAtom] = []
        found = False
        for atom in graph.atoms:
            if atom.id != key:
                next_atoms.append(atom)
                continue
            next_atoms.append(dataclasses.replace(atom, value=text, last_seen=time.time()))
            found = True
        if not found:
            return None
        graph.atoms = next_atoms
        if graph.summary_auto or not graph.summary:
            graph.summary = summary_from_atoms(rank_atoms(graph.atoms))
            graph.summary_auto = True
        self.save_memory_graph(graph)
        return graph

    def merge_atoms(self, user_id_hash: str, incoming: Sequence[MemoryAtom]) -> tuple[MemoryGraph, List[MemoryAtom]]:
        """Merge a small structured delta with reinforcement and salience eviction.

        Returns atoms that were created or whose value changed. A fact the
        person repeats is reinforced (more mentions, fresher, slightly more
        confident) rather than ignored. When memory is full the least salient
        fact is evicted; previously the list was truncated from the end, so once
        it filled up every new fact about the person was silently discarded.
        """
        graph = self.get_memory_graph(user_id_hash)
        if not incoming:
            return graph, []
        now = time.time()
        merged = list(graph.atoms)
        by_id = {atom.id: index for index, atom in enumerate(merged)}
        by_value = {_normalize_atom_value(atom.value): index for index, atom in enumerate(merged)}
        saved: List[MemoryAtom] = []
        for atom in incoming:
            if not atom.value.strip():
                continue
            normalized = _normalize_atom_value(atom.value)
            index = by_id.get(atom.id)
            if index is None:
                index = by_value.get(normalized)
            if index is not None:
                existing = merged[index]
                same_value = _normalize_atom_value(existing.value) == normalized
                if not same_value and atom.confidence < existing.confidence:
                    continue
                updated = MemoryAtom(
                    id=existing.id,
                    category=atom.category or existing.category,
                    value=existing.value if same_value else atom.value.strip(),
                    confidence=min(1.0, max(existing.confidence, atom.confidence) + (0.05 if same_value else 0.0)),
                    mentions=existing.mentions + 1,
                    first_seen=existing.first_seen or now,
                    last_seen=now,
                )
                by_value.pop(_normalize_atom_value(existing.value), None)
                merged[index] = updated
                by_value[_normalize_atom_value(updated.value)] = index
                if not same_value:
                    saved.append(updated)
                continue
            created = MemoryAtom(
                id=atom.id,
                category=atom.category or "facts",
                value=atom.value.strip(),
                confidence=atom.confidence,
                mentions=1,
                first_seen=now,
                last_seen=now,
            )
            merged.append(created)
            by_id[atom.id] = len(merged) - 1
            by_value[normalized] = len(merged) - 1
            saved.append(created)
        graph.atoms = rank_atoms(merged, now=now)[:_MAX_ATOMS]
        kept_ids = {atom.id for atom in graph.atoms}
        saved = [atom for atom in saved if atom.id in kept_ids]
        if graph.atoms and (graph.summary_auto or not graph.summary or graph.summary in _PLACEHOLDER_SUMMARIES):
            graph.summary = summary_from_atoms(graph.atoms)
            graph.summary_auto = True
        self.save_memory_graph(graph)
        return graph, saved

    def prompt_for_user(self, user_id_hash: str) -> MemoryPrompt:
        graph = self.get_memory_graph(user_id_hash)
        profile = self.store.get_document("user_profiles", user_id_hash) or {}
        return format_memory_prompt(graph, display_name=profile.get("display_name"))


def _atoms_from_payload(payload: Dict[str, Any]) -> List[MemoryAtom]:
    raw = payload.get("atoms") or payload.get("items") or []
    if isinstance(raw, dict):
        values: Iterable[Any] = raw.values()
    elif isinstance(raw, list):
        values = raw
    else:
        return []
    atoms: List[MemoryAtom] = []
    seen: set[str] = set()
    for item in values:
        atom = atom_from_mapping(item)
        if atom is None or atom.id in seen:
            continue
        seen.add(atom.id)
        atoms.append(atom)
    return atoms


def format_memory_receipt(saved: Sequence[MemoryAtom]) -> Dict[str, Any]:
    """User-facing receipt of atoms that stuck. Short display text only — no transcripts."""
    items: List[Dict[str, str]] = []
    for atom in saved:
        text = " ".join((atom.value or "").split())
        if not text:
            continue
        if len(text) > _MAX_RECEIPT_TEXT:
            clipped = text[:_MAX_RECEIPT_TEXT].rsplit(" ", 1)[0].strip()
            text = clipped or text[:_MAX_RECEIPT_TEXT]
        category = (atom.category or "facts").strip() or "facts"
        items.append({"id": atom.id, "type": category, "text": text})
    return {"saved": items, "count": len(items)}


def _looks_generated(summary: str, atoms: Sequence[MemoryAtom]) -> bool:
    if not atoms:
        return False
    return summary in {summary_from_atoms(atoms), summary_from_atoms(rank_atoms(atoms))} or all(
        part.split(": ", 1)[0].lower().rstrip("s") in {(a.category or "facts").replace("_", " ").lower().rstrip("s") for a in atoms}
        for part in summary.split(". ")
        if part
    )


def summary_from_atoms(atoms: Sequence[MemoryAtom]) -> str:
    """One honest sentence per category from stored atoms. No invented detail."""
    grouped: Dict[str, List[str]] = {}
    for atom in atoms[:_REBUILD_ATOMS]:
        text = " ".join((atom.value or "").split())
        if not text:
            continue
        values = grouped.setdefault((atom.category or "facts").strip() or "facts", [])
        if text not in values:
            values.append(text)
    if not grouped:
        return ""
    parts = [f"{_category_label(category)}: {'; '.join(values)}" for category, values in grouped.items()]
    return ". ".join(parts)[:_MAX_SUMMARY_CHARS].strip()


def clip_atom_value(value: str) -> str:
    text = " ".join((value or "").split())
    if len(text) <= _MAX_ATOM_VALUE_CHARS:
        return text
    clipped = text[:_MAX_ATOM_VALUE_CHARS].rsplit(" ", 1)[0].strip()
    return clipped or text[:_MAX_ATOM_VALUE_CHARS]


def _normalize_atom_value(value: str) -> str:
    return " ".join((value or "").strip().lower().split())


def _preferred_name(value: Any) -> str:
    name = str(value or "").strip()
    if not name or name.lower() in _PLACEHOLDER_NAMES:
        return ""
    return name.split()[0]


def _category_label(category: str) -> str:
    cleaned = category.replace("_", " ").replace("/", " ").strip()
    return cleaned[:1].upper() + cleaned[1:] if cleaned else "Facts"
