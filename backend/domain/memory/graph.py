# backend/domain/memory/graph.py — Memory Graph Domain

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence

from backend.infra.store.store import get_store

_PLACEHOLDER_SUMMARIES = frozenset(
    {
        "user is building a therapeutic reflective space.",
        "user reflective context.",
    }
)
_PLACEHOLDER_NAMES = frozenset({"mindpal user", "user", "guest"})
_INACTIVE_STATUSES = frozenset({"deleted", "tombstone", "tombstoned", "archived", "inactive"})
_MAX_ATOMS = 16
_MAX_SUMMARY_CHARS = 800
_MAX_PROMPT_CHARS = 1_200
_MAX_RECEIPT_TEXT = 80
_MAX_ATOM_VALUE_CHARS = 240
_REBUILD_ATOMS = 8

# Public names for the HTTP layer, so the PUT path enforces the same ceilings the
# merge path does instead of inventing its own.
MAX_ATOMS = _MAX_ATOMS
MAX_SUMMARY_CHARS = _MAX_SUMMARY_CHARS
MAX_ATOM_VALUE_CHARS = _MAX_ATOM_VALUE_CHARS
_PROMPT_PREAMBLE = (
    "Known user memory. Use only when relevant. Do not invent additional personal facts. "
    "Stored details may be outdated if the conversation contradicts them."
)


@dataclass
class MemoryAtom:
    id: str
    category: str
    value: str
    confidence: float = 1.0


@dataclass
class MemoryGraph:
    user_id_hash: str
    summary: str = ""
    atoms: List[MemoryAtom] = field(default_factory=list)


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
    return MemoryAtom(id=atom_id, category=category, value=value, confidence=confidence)


def format_memory_prompt(
    graph: MemoryGraph,
    *,
    display_name: Optional[str] = None,
    max_atoms: int = _MAX_ATOMS,
    max_chars: int = _MAX_PROMPT_CHARS,
) -> MemoryPrompt:
    """Build a prompt block from stored facts only. Empty memory yields an empty string."""
    summary = honest_summary(graph.summary)
    preferred_name = _preferred_name(display_name)
    atoms = [atom for atom in graph.atoms if atom.value.strip()][:max_atoms]

    lines: List[str] = []
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
    return MemoryPrompt(text="\n".join(body_lines), atom_count=len(atoms), has_summary=bool(summary))


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
        return MemoryGraph(
            user_id_hash=user_id_hash,
            summary=honest_summary(payload.get("summary") or payload.get("summary_text")),
            atoms=_atoms_from_payload(payload),
        )

    def save_memory_graph(self, graph: MemoryGraph) -> None:
        doc = {
            "user_id_hash": graph.user_id_hash,
            "summary": honest_summary(graph.summary),
            "atoms": [
                {"id": a.id, "category": a.category, "value": a.value, "confidence": a.confidence}
                for a in graph.atoms
            ],
        }
        self.store.set_document("memory_graphs", graph.user_id_hash, doc)

    def update_summary(self, user_id_hash: str, new_summary: str) -> MemoryGraph:
        graph = self.get_memory_graph(user_id_hash)
        graph.summary = honest_summary(new_summary)
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
        graph.summary = summary_from_atoms(graph.atoms)
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
            next_atoms.append(
                MemoryAtom(id=atom.id, category=atom.category, value=text, confidence=atom.confidence)
            )
            found = True
        if not found:
            return None
        graph.atoms = next_atoms
        graph.summary = summary_from_atoms(graph.atoms)
        self.save_memory_graph(graph)
        return graph

    def merge_atoms(self, user_id_hash: str, incoming: Sequence[MemoryAtom]) -> tuple[MemoryGraph, List[MemoryAtom]]:
        """Merge a small structured delta. Returns atoms that were created or whose value changed."""
        graph = self.get_memory_graph(user_id_hash)
        if not incoming:
            return graph, []
        merged = list(graph.atoms)
        by_id = {atom.id: index for index, atom in enumerate(merged)}
        seen_values = {_normalize_atom_value(atom.value) for atom in merged}
        saved: List[MemoryAtom] = []
        for atom in incoming:
            if not atom.value.strip():
                continue
            normalized = _normalize_atom_value(atom.value)
            if atom.id in by_id:
                existing = merged[by_id[atom.id]]
                if atom.confidence >= existing.confidence:
                    seen_values.discard(_normalize_atom_value(existing.value))
                    updated = MemoryAtom(
                        id=existing.id,
                        category=atom.category or existing.category,
                        value=atom.value.strip(),
                        confidence=atom.confidence,
                    )
                    merged[by_id[atom.id]] = updated
                    seen_values.add(normalized)
                    saved.append(updated)
                continue
            if normalized in seen_values:
                continue
            created = MemoryAtom(
                id=atom.id,
                category=atom.category or "facts",
                value=atom.value.strip(),
                confidence=atom.confidence,
            )
            merged.append(created)
            by_id[atom.id] = len(merged) - 1
            seen_values.add(normalized)
            saved.append(created)
        graph.atoms = merged[:_MAX_ATOMS]
        kept_ids = {atom.id for atom in graph.atoms}
        saved = [atom for atom in saved if atom.id in kept_ids]
        if graph.atoms and (not graph.summary or graph.summary in _PLACEHOLDER_SUMMARIES):
            graph.summary = summary_from_atoms(graph.atoms)
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
