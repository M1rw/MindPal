from __future__ import annotations

import json
import logging
import re
from datetime import UTC, datetime

from backend.core.security import sanitize_text
from backend.services.llm_service import LLMService, build_llm_request
from backend.models.memory import (
    MemoryAtom,
    MemoryCategory,
    MemoryGraph,
    MemorySensitivity,
    MemorySource,
    MemoryStatus,
    MemorySummary,
    build_memory_prompt_from_graph,
    canonical_memory_key,
    make_memory_atom,
    memory_graph_from_summary,
    normalize_memory_value,
)

logger = logging.getLogger(__name__)


TOMBSTONE_RECREATE_HOURS = 24
MANUAL_CONFIDENCE = 0.95
CHAT_CONFIDENCE = 0.65
LLM_CONFIDENCE = 0.6


def merge_memory_graph(existing: MemoryGraph, incoming: MemoryGraph | list[MemoryAtom]) -> MemoryGraph:
    incoming_atoms = incoming.atoms if isinstance(incoming, MemoryGraph) else incoming
    merged = existing.model_copy(deep=True)

    for atom in incoming_atoms:
        merged = upsert_memory_atom(merged, atom)

    merged.version = max(existing.version + (1 if incoming_atoms else 0), getattr(incoming, "version", existing.version))
    merged.updated_at = _utcnow()
    merged.full_snapshot = True
    return merged


def upsert_memory_atom(graph: MemoryGraph, atom: MemoryAtom) -> MemoryGraph:
    next_graph = graph.model_copy(deep=True)
    incoming = _normalized_atom(atom, graph.user_id_hash)

    tombstone = _find_tombstone(next_graph, incoming)
    if tombstone and incoming.source != MemorySource.MANUAL:
        return next_graph

    match_index = _find_matching_atom_index(next_graph.atoms, incoming)
    if match_index < 0:
        next_graph.atoms.append(incoming)
        next_graph.updated_at = _utcnow()
        return next_graph

    current = next_graph.atoms[match_index]

    if current.status == MemoryStatus.DELETED and incoming.source != MemorySource.MANUAL:
        return next_graph

    if current.pinned and not incoming.pinned and incoming.confidence < current.confidence:
        next_graph.atoms[match_index] = current.model_copy(
            update={
                "aliases": _merge_aliases(current.aliases, incoming.aliases),
                "last_seen_at": max(current.last_seen_at, incoming.last_seen_at),
                "evidence_count": min(current.evidence_count + max(1, incoming.evidence_count), 10_000),
                "confidence": _reinforced_confidence(current.confidence, incoming),
                "updated_at": max(current.updated_at, incoming.updated_at),
            }
        )
        return next_graph

    display_source = incoming if _incoming_display_wins(current, incoming) else current
    status = incoming.status if incoming.status == MemoryStatus.DELETED else current.status
    if incoming.source == MemorySource.MANUAL:
        status = incoming.status

    next_graph.atoms[match_index] = current.model_copy(
        update={
            "value": display_source.value,
            "display_value": display_source.display_value,
            "normalized_value": display_source.normalized_value,
            "confidence": _reinforced_confidence(current.confidence, incoming),
            "sensitivity": _max_sensitivity(current.sensitivity, incoming.sensitivity),
            "source": _stronger_source(current.source, incoming.source),
            "status": status,
            "pinned": current.pinned or incoming.pinned,
            "updated_at": max(current.updated_at, incoming.updated_at),
            "last_seen_at": max(current.last_seen_at, incoming.last_seen_at),
            "evidence_count": min(current.evidence_count + max(1, incoming.evidence_count), 10_000),
            "aliases": _merge_aliases(current.aliases, incoming.aliases),
            "metadata": {**current.metadata, **incoming.metadata},
        }
    )
    next_graph.updated_at = _utcnow()
    return next_graph


def delete_memory_atom(graph: MemoryGraph, atom_id: str, tombstone: bool = True) -> MemoryGraph:
    next_graph = graph.model_copy(deep=True)
    now = _utcnow()

    for index, atom in enumerate(next_graph.atoms):
        if atom.id != atom_id:
            continue
        if tombstone:
            next_graph.atoms[index] = atom.model_copy(
                update={
                    "status": MemoryStatus.DELETED,
                    "updated_at": now,
                    "last_seen_at": now,
                    "pinned": False,
                    "metadata": {**atom.metadata, "deleted_by_user": True},
                }
            )
        else:
            del next_graph.atoms[index]
        next_graph.version += 1
        next_graph.updated_at = now
        return next_graph

    return next_graph


def archive_memory_atom(graph: MemoryGraph, atom_id: str) -> MemoryGraph:
    next_graph = graph.model_copy(deep=True)
    now = _utcnow()

    for index, atom in enumerate(next_graph.atoms):
        if atom.id == atom_id:
            next_graph.atoms[index] = atom.model_copy(update={"status": MemoryStatus.ARCHIVED, "updated_at": now})
            next_graph.version += 1
            next_graph.updated_at = now
            break

    return next_graph


def build_memory_graph_prompt(graph: MemoryGraph) -> str:
    return build_memory_prompt_from_graph(graph)


def memory_graph_delta_from_summary(summary: MemorySummary, *, source: MemorySource = MemorySource.BACKEND_COMPACTION) -> MemoryGraph:
    graph = memory_graph_from_summary(summary)
    graph.source = source
    graph.full_snapshot = False
    graph.atoms = [
        atom.model_copy(update={"source": source, "confidence": min(atom.confidence, 0.78)})
        for atom in graph.atoms
        if atom.confidence >= 0.55
    ]
    return graph


def extract_memory_graph_from_text(
    text: str,
    *,
    user_id_hash: str,
    explicit: bool | None = None,
) -> MemoryGraph:
    cleaned = sanitize_text(str(text or ""), 2_000)
    explicit = _is_explicit_memory_command(cleaned) if explicit is None else explicit
    source = MemorySource.MANUAL if explicit else MemorySource.CHAT_EXTRACTION
    confidence = MANUAL_CONFIDENCE if explicit else CHAT_CONFIDENCE
    atoms: list[MemoryAtom] = []

    for pattern in (
        re.compile(r"(?i)\b(?:my name is|call me|i am called|i'm called)\s+([^.,!?\n]{2,80})"),
        re.compile(r"(?:اسمي|ناديني|اسمي هو)\s+([^.,!?\n،؟]{2,80})"),
    ):
        match = pattern.search(cleaned)
        if match:
            name = _clean_value(match.group(1), max_words=4)
            if name:
                atoms.append(make_memory_atom(
                    user_id_hash=user_id_hash,
                    category=MemoryCategory.PROFILE,
                    value=name,
                    display_value=f"Preferred name: {name}",
                    confidence=confidence,
                    source=source,
                    sensitivity=MemorySensitivity.LOW,
                    metadata={"field": "preferred_name"},
                    pinned=explicit,
                ))

    project = _capture(cleaned, [
        re.compile(r"(?i)\bmy project is\s+([^.,!?\n]{2,100})"),
        re.compile(r"(?i)\b(?:i am working on|i'm working on)\s+([^.,!?\n]{2,100})"),
    ])
    if project:
        atoms.append(make_memory_atom(
            user_id_hash=user_id_hash,
            category=MemoryCategory.PROJECTS,
            value=project,
            confidence=confidence,
            source=source,
            sensitivity=MemorySensitivity.LOW,
            pinned=explicit,
        ))

    person = _capture_person(cleaned)
    if person:
        name, relationship, aliases = person
        atoms.append(make_memory_atom(
            user_id_hash=user_id_hash,
            category=MemoryCategory.PEOPLE,
            value=name,
            display_value=f"{' / '.join(aliases or [name])} - {relationship}",
            confidence=max(confidence, 0.8),
            source=source,
            sensitivity=MemorySensitivity.MEDIUM,
            aliases=aliases or [name],
            metadata={"relationship": relationship},
            pinned=explicit,
        ))

    for value in _extract_preferences(cleaned):
        atoms.append(make_memory_atom(
            user_id_hash=user_id_hash,
            category=MemoryCategory.PREFERENCES,
            value=value,
            confidence=confidence,
            source=source,
            sensitivity=MemorySensitivity.LOW,
            pinned=explicit,
        ))

    for value in _extract_avoid(cleaned):
        atoms.append(make_memory_atom(
            user_id_hash=user_id_hash,
            category=MemoryCategory.AVOID,
            value=value,
            confidence=MANUAL_CONFIDENCE if explicit else 0.74,
            source=source,
            sensitivity=MemorySensitivity.LOW,
            pinned=explicit,
        ))

    return MemoryGraph(
        user_id_hash=user_id_hash,
        atoms=atoms,
        source=source,
        full_snapshot=False,
    )


def _normalized_atom(atom: MemoryAtom, user_id_hash: str) -> MemoryAtom:
    normalized = normalize_memory_value(atom.value)
    key = canonical_memory_key(atom.category.value, atom.value, atom.metadata)
    if atom.key == key and atom.normalized_value == normalized:
        return atom
    return atom.model_copy(update={"key": key, "normalized_value": normalized})


def _find_matching_atom_index(atoms: list[MemoryAtom], incoming: MemoryAtom) -> int:
    incoming_aliases = {normalize_memory_value(alias) for alias in incoming.aliases if alias}

    for index, atom in enumerate(atoms):
        if atom.category != incoming.category:
            continue
        if atom.key == incoming.key:
            return index
        if atom.normalized_value == incoming.normalized_value:
            return index
        if incoming.category == MemoryCategory.PEOPLE:
            aliases = {normalize_memory_value(alias) for alias in atom.aliases if alias}
            if aliases.intersection(incoming_aliases):
                return index
            if atom.metadata.get("relationship") and atom.metadata.get("relationship") == incoming.metadata.get("relationship"):
                return index

    return -1


def _find_tombstone(graph: MemoryGraph, incoming: MemoryAtom) -> MemoryAtom | None:
    for atom in graph.atoms:
        if atom.status != MemoryStatus.DELETED:
            continue
        if atom.category != incoming.category:
            continue
        if atom.key == incoming.key or atom.normalized_value == incoming.normalized_value:
            return atom
    return None


def _incoming_display_wins(current: MemoryAtom, incoming: MemoryAtom) -> bool:
    if incoming.source == MemorySource.MANUAL and current.source != MemorySource.MANUAL:
        return True
    if incoming.pinned and not current.pinned:
        return True
    if incoming.confidence > current.confidence:
        return True
    return incoming.updated_at > current.updated_at and incoming.confidence >= current.confidence


def _reinforced_confidence(current: float, incoming: MemoryAtom) -> float:
    cap = 1.0 if incoming.source == MemorySource.MANUAL or incoming.pinned else 0.98
    bump = 0.04 * max(1, incoming.evidence_count)
    return min(cap, max(current, incoming.confidence) + bump)


def _stronger_source(current: MemorySource, incoming: MemorySource) -> MemorySource:
    rank = {
        MemorySource.CHAT_EXTRACTION: 1,
        MemorySource.BACKEND_COMPACTION: 2,
        MemorySource.IMPORT: 3,
        MemorySource.PROFILE: 4,
        MemorySource.MANUAL: 5,
    }
    return incoming if rank[incoming] >= rank[current] else current


def _max_sensitivity(left: MemorySensitivity, right: MemorySensitivity) -> MemorySensitivity:
    rank = {MemorySensitivity.LOW: 1, MemorySensitivity.MEDIUM: 2, MemorySensitivity.HIGH: 3}
    return right if rank[right] > rank[left] else left


def _merge_aliases(left: list[str], right: list[str]) -> list[str]:
    output: list[str] = []
    seen: set[str] = set()
    for alias in [*left, *right]:
        clean = _clean_value(alias, max_words=8)
        key = normalize_memory_value(clean)
        if not clean or key in seen:
            continue
        seen.add(key)
        output.append(clean)
    return output[:30]


def _is_explicit_memory_command(text: str) -> bool:
    lower = text.lower().strip()
    return lower.startswith("remember:") or lower.startswith("remember this") or lower.startswith("remember ")


def _capture(text: str, patterns: list[re.Pattern[str]]) -> str:
    for pattern in patterns:
        match = pattern.search(text)
        if match:
            return _clean_value(match.group(1), max_words=8)
    return ""


def _capture_person(text: str) -> tuple[str, str, list[str]] | None:
    patterns = [
        ("girlfriend", re.compile(r"(?i)\bmy girlfriend\s+(?:is\s+)?(?:called|named|is)\s+([^.\n]{2,120})")),
        ("boyfriend", re.compile(r"(?i)\bmy boyfriend\s+(?:is\s+)?(?:called|named|is)\s+([^.\n]{2,120})")),
        ("partner", re.compile(r"(?i)\bmy partner\s+(?:is\s+)?(?:called|named|is)\s+([^.\n]{2,120})")),
    ]
    for relationship, pattern in patterns:
        match = pattern.search(text)
        if not match:
            continue
        aliases = _extract_aliases(match.group(1))
        if aliases:
            return aliases[0], relationship, aliases
    return None


def _extract_preferences(text: str) -> list[str]:
    values: list[str] = []
    for pattern in (
        re.compile(r"(?i)\bI prefer\s+([^.,!?\n]{3,120})"),
        re.compile(r"(?i)\bplease be\s+([^.,!?\n]{3,120})"),
    ):
        match = pattern.search(text)
        if match:
            values.append(_clean_value(match.group(1), max_words=10))
    if re.search(r"(?i)\bdirect answers|be direct|no fluff|concise\b", text):
        values.append("direct answers")
    return _unique(values)


def _extract_avoid(text: str) -> list[str]:
    values: list[str] = []
    for pattern in (
        re.compile(r"(?i)\bavoid\s+([^.,!?\n]{3,140})"),
        re.compile(r"(?i)\bdo not answer like\s+([^.,!?\n]{3,140})"),
        re.compile(r"(?i)\bdon't answer like\s+([^.,!?\n]{3,140})"),
    ):
        match = pattern.search(text)
        if match:
            values.append(_clean_avoid_value(match.group(1)))
    return _unique(values)


def _extract_aliases(value: str) -> list[str]:
    raw = re.sub(r"(?i)\b(?:or|aka|also known as|also|may write|write her name as|write his name as)\b", ",", value)
    raw = raw.replace("/", ",")
    return _unique([_clean_value(part, max_words=5) for part in raw.split(",")])


def _clean_avoid_value(value: str) -> str:
    cleaned = _clean_value(value, max_words=8)
    cleaned = re.sub(r"(?i)\b^(being|be|too)\s+", "", cleaned).strip()
    if cleaned and not cleaned.endswith("responses") and not cleaned.endswith("style"):
        if len(cleaned.split()) <= 3:
            cleaned = f"{cleaned} responses"
    return cleaned


def _clean_value(value: str, *, max_words: int) -> str:
    cleaned = sanitize_text(str(value or ""), 180)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .,!?:;،؟'\"")
    words = cleaned.split()
    if len(words) > max_words:
        cleaned = " ".join(words[:max_words])
    return cleaned


def _unique(values: list[str]) -> list[str]:
    output: list[str] = []
    seen: set[str] = set()
    for value in values:
        key = normalize_memory_value(value)
        if not value or key in seen:
            continue
        seen.add(key)
        output.append(value)
    return output


def _utcnow() -> datetime:
    return datetime.now(UTC)


MEMORY_GRAPH_SYSTEM_PROMPT = """
You are MindPal's realtime memory extraction engine.

Your job is to read a chat message from the user and extract any durable personal facts, relationships, preferences, or goals.
If no memory is found, return an empty array.

Return EXACTLY a JSON object with this shape:
{
  "atoms": [
    {
      "category": "profile|people|projects|preferences|avoid|patterns|goals|relationship_context|coping_tools|safety_context|facts",
      "value": "string max 180 chars",
      "confidence": 0.0 to 1.0,
      "sensitivity": "low|medium|high",
      "aliases": ["optional list of strings"],
      "metadata": {}
    }
  ]
}

DO NOT wrap the JSON in Markdown formatting like ```json.
"""

async def extract_memory_graph_from_text_llm(
    text: str,
    *,
    user_id_hash: str,
    llm_service: LLMService,
    explicit: bool | None = None,
) -> MemoryGraph:
    cleaned = sanitize_text(str(text or ""), 2_000)
    if not cleaned:
        return MemoryGraph(user_id_hash=user_id_hash, atoms=[], full_snapshot=False)
        
    explicit = _is_explicit_memory_command(cleaned) if explicit is None else explicit
    source = MemorySource.MANUAL if explicit else MemorySource.CHAT_EXTRACTION
    confidence_cap = MANUAL_CONFIDENCE if explicit else CHAT_CONFIDENCE

    req = build_llm_request(
        request_id="mem_extract",
        system_prompt=MEMORY_GRAPH_SYSTEM_PROMPT.strip(),
        user_message=cleaned,
        temperature=0.1,
        max_output_tokens=800,
        metadata={"purpose": "realtime_memory_extraction"}
    )
    
    atoms_out = []
    
    try:
        res = await llm_service.generate_with_trace(req)
        raw_text = res.response.text.strip()
        
        # Robust JSON extraction — handle various LLM output formats
        data = _extract_json_from_llm_output(raw_text)
        
        if data is None:
            # No valid JSON found — not an error, just no memories extracted
            logger.debug("Memory extraction returned non-JSON output")
            return MemoryGraph(user_id_hash=user_id_hash, atoms=[], source=source, full_snapshot=False)
        
        for atom_data in data.get("atoms", []):
            try:
                atoms_out.append(make_memory_atom(
                    user_id_hash=user_id_hash,
                    category=MemoryCategory(atom_data.get("category", "facts")),
                    value=atom_data.get("value", ""),
                    confidence=min(confidence_cap, float(atom_data.get("confidence", 0.6))),
                    source=source,
                    sensitivity=MemorySensitivity(atom_data.get("sensitivity", "medium")),
                    aliases=atom_data.get("aliases", []),
                    metadata=atom_data.get("metadata", {}),
                    pinned=explicit,
                ))
            except Exception:
                logger.debug("Skipping invalid memory atom from LLM extraction", exc_info=True)
                
    except Exception as e:
        logger.warning("LLM memory extraction failed: %s", type(e).__name__)

    return MemoryGraph(
        user_id_hash=user_id_hash,
        atoms=atoms_out,
        source=source,
        full_snapshot=False,
    )


def _extract_json_from_llm_output(raw_text: str) -> dict | None:
    """
    Extract a JSON object from LLM output, handling common formatting issues.
    
    Small models (Groq llama, Cloudflare) frequently:
    - Wrap JSON in ```json ... ``` markdown fences
    - Add explanatory text before/after the JSON
    - Include trailing commas
    - Return "No memories found" instead of {"atoms": []}
    """
    if not raw_text:
        return None

    text = raw_text.strip()

    # Strategy 1: Strip markdown code fences
    if "```" in text:
        # Extract content between ```json ... ``` or ``` ... ```
        fence_match = re.search(r"```(?:json)?\s*\n?(.*?)\n?\s*```", text, re.DOTALL)
        if fence_match:
            text = fence_match.group(1).strip()

    # Strategy 2: Direct JSON parse
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            return data
    except json.JSONDecodeError:
        pass

    # Strategy 3: Find JSON object with regex (handles text before/after JSON)
    json_match = re.search(r"\{[^{}]*\"atoms\"\s*:\s*\[.*?\]\s*\}", text, re.DOTALL)
    if json_match:
        try:
            data = json.loads(json_match.group(0))
            if isinstance(data, dict):
                return data
        except json.JSONDecodeError:
            pass

    # Strategy 4: Find any JSON object (even without "atoms" key)
    json_match = re.search(r"\{.*\}", text, re.DOTALL)
    if json_match:
        try:
            # Try to fix trailing commas before parsing
            candidate = json_match.group(0)
            candidate = re.sub(r",\s*([}\]])", r"\1", candidate)
            data = json.loads(candidate)
            if isinstance(data, dict):
                return data
        except json.JSONDecodeError:
            pass

    # Strategy 5: Empty result (model said "no memories" or similar)
    lower = text.lower()
    if any(phrase in lower for phrase in ("no memor", "no durable", "no personal", "empty", "none")):
        return {"atoms": []}

    return None

