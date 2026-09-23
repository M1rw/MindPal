# backend/domain/grounding/grounding.py — Clinical corpus retrieval for chat turns

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path
from typing import Dict, Iterable, List, Sequence

import yaml

from backend.configs.runtime import domain_limits_config
from backend.infra.llm.embeddings import cosine, get_embedder

logger = logging.getLogger("mindpal.grounding")

REPO_ROOT = Path(__file__).resolve().parents[3]
CLINICAL_CORPUS_DIR = REPO_ROOT / "data" / "clinical_frameworks"
CORE_CORPUS_DIR = REPO_ROOT / "backend" / "rag" / "corpus"

_GROUNDING_LIMITS = domain_limits_config()["grounding"]
SEMANTIC_FLOOR = float(_GROUNDING_LIMITS.get("semantic_floor", 0.55))
SEMANTIC_WEIGHT = float(_GROUNDING_LIMITS.get("semantic_weight", 1.5))
EMBEDDINGS_FILE = CLINICAL_CORPUS_DIR / "embeddings.json"
DEFAULT_LIMIT = int(_GROUNDING_LIMITS["default_limit"])
MIN_SCORE = float(_GROUNDING_LIMITS["min_score"])
MAX_INSTRUCTIONS = int(_GROUNDING_LIMITS["max_instructions"])
MAX_CONTRAINDICATIONS = int(_GROUNDING_LIMITS["max_contraindications"])
MAX_CONTENT_CHARS = int(_GROUNDING_LIMITS["max_content_chars"])
_PHRASE_HIT = float(_GROUNDING_LIMITS["phrase_hit"])
_TERM_HIT = float(_GROUNDING_LIMITS["term_hit"])


@dataclass(frozen=True, slots=True)
class GroundingChunk:
    id: str
    topic: str
    content: str


@dataclass(frozen=True, slots=True)
class CorpusUnit:
    id: str
    category: str
    technique: str
    trigger_terms: tuple[str, ...]
    instructions: tuple[str, ...]
    contraindications: tuple[str, ...]
    tags: tuple[str, ...]

    def render(self) -> str:
        steps = " ".join(self.instructions[:MAX_INSTRUCTIONS]).strip()
        avoids = " ".join(self.contraindications[:MAX_CONTRAINDICATIONS]).strip()
        body = steps
        if avoids:
            body = f"{body} Do not: {avoids}".strip()
        return body[:MAX_CONTENT_CHARS]


def _clean_text(value: object, max_chars: int = 240) -> str:
    return " ".join(str(value or "").split())[:max_chars].strip()


def _clean_list(value: object, *, max_items: int, max_chars: int) -> tuple[str, ...]:
    if isinstance(value, str):
        items: Iterable[object] = [value]
    elif isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        items = value
    else:
        items = ()
    cleaned: list[str] = []
    for item in items:
        text = _clean_text(item, max_chars)
        if text:
            cleaned.append(text)
        if len(cleaned) >= max_items:
            break
    return tuple(cleaned)


def _iter_corpus_files() -> tuple[Path, ...]:
    files: list[Path] = []
    seen: set[str] = set()
    for directory in (CLINICAL_CORPUS_DIR, CORE_CORPUS_DIR):
        if not directory.is_dir():
            continue
        for path in sorted((*directory.glob("*.yaml"), *directory.glob("*.yml"))):
            key = str(path.resolve()).lower()
            if key in seen:
                continue
            seen.add(key)
            files.append(path)
    return tuple(files)


def _parse_unit(raw: object) -> CorpusUnit | None:
    if not isinstance(raw, dict):
        return None
    unit_id = _clean_text(raw.get("id") or raw.get("grounding_id"), 120)
    technique = _clean_text(raw.get("technique"), 160)
    instructions = _clean_list(raw.get("instructions"), max_items=20, max_chars=400)
    if not unit_id or not technique or not instructions:
        return None
    triggers = _clean_list(
        raw.get("trigger_terms") or raw.get("triggers") or raw.get("keywords"),
        max_items=40,
        max_chars=80,
    )
    tags = _clean_list(raw.get("tags") or raw.get("rag_tags"), max_items=24, max_chars=80)
    if not triggers and not tags:
        return None
    return CorpusUnit(
        id=unit_id,
        category=_clean_text(raw.get("category"), 80) or "support",
        technique=technique,
        trigger_terms=tuple(term.lower() for term in triggers),
        instructions=instructions,
        contraindications=_clean_list(raw.get("contraindications"), max_items=20, max_chars=400),
        tags=tuple(tag.lower() for tag in tags),
    )


def load_corpus_units() -> tuple[CorpusUnit, ...]:
    units: list[CorpusUnit] = []
    seen_ids: set[str] = set()
    files = _iter_corpus_files()
    if not files:
        logger.warning("grounding_corpus_missing clinical=%s core=%s", CLINICAL_CORPUS_DIR.name, CORE_CORPUS_DIR.name)
        return ()

    for path in files:
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError):
            logger.warning("grounding_corpus_parse_failed file=%s", path.name)
            continue
        if data is None:
            continue
        if isinstance(data, dict) and "units" in data:
            raw_units = data.get("units")
        elif isinstance(data, list):
            raw_units = data
        elif isinstance(data, dict):
            raw_units = [data]
        else:
            logger.warning("grounding_corpus_invalid file=%s", path.name)
            continue
        if not isinstance(raw_units, list):
            logger.warning("grounding_corpus_invalid file=%s", path.name)
            continue
        for raw in raw_units:
            unit = _parse_unit(raw)
            if unit is None or unit.id in seen_ids:
                continue
            seen_ids.add(unit.id)
            units.append(unit)

    logger.info("grounding_corpus_loaded units=%s files=%s", len(units), len(files))
    return tuple(units)


def _score_unit(query_lower: str, unit: CorpusUnit) -> float:
    score = 0.0
    for term in unit.trigger_terms:
        if not term or term not in query_lower:
            continue
        score += _PHRASE_HIT if " " in term else _TERM_HIT
    return score


def unit_fingerprint(unit: CorpusUnit) -> str:
    text = "|".join((unit.technique, unit.category, " ".join(unit.trigger_terms), unit.render()))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def unit_embedding_text(unit: CorpusUnit) -> str:
    return f"{unit.technique}. {unit.category}. When: {', '.join(unit.trigger_terms)}. {unit.render()}"


class GroundingService:
    """Lexical retrieval over the curated clinical / wellness corpus."""

    def __init__(self, units: Sequence[CorpusUnit] | None = None) -> None:
        self._override_units = None if units is None else tuple(units)

    @cached_property
    def units(self) -> tuple[CorpusUnit, ...]:
        if self._override_units is not None:
            return self._override_units
        return load_corpus_units()

    @cached_property
    def unit_vectors(self) -> Dict[str, List[float]]:
        """Precomputed library vectors (scripts/ops/build_grounding_embeddings.py).

        A vector whose unit text changed since it was built is ignored, so an
        edited technique can never be matched on its old meaning.
        """
        try:
            payload = json.loads(EMBEDDINGS_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        stored = payload.get("units") if isinstance(payload, dict) else None
        if not isinstance(stored, dict):
            return {}
        current = {unit.id: unit_fingerprint(unit) for unit in self.units}
        return {
            unit_id: list(entry["vector"])
            for unit_id, entry in stored.items()
            if isinstance(entry, dict) and current.get(unit_id) == entry.get("hash") and isinstance(entry.get("vector"), list)
        }

    def _semantic_scores(self, message: str, semantic: bool) -> Dict[str, float]:
        if not semantic or not self.unit_vectors:
            return {}
        embedder = get_embedder()
        vectors = embedder.embed([message], task="RETRIEVAL_QUERY") if embedder else None
        if not vectors:
            return {}
        query = vectors[0]
        return {
            unit_id: max(0.0, cosine(query, vector) - SEMANTIC_FLOOR) * SEMANTIC_WEIGHT
            for unit_id, vector in self.unit_vectors.items()
        }

    def retrieve_context(self, message: str, limit: int = DEFAULT_LIMIT, *, semantic: bool = False) -> List[GroundingChunk]:
        """Hybrid ranking: keyword hits plus, when allowed, similarity of meaning.

        "I froze in the meeting" reaches the anxiety techniques even though it
        shares no keyword with them. Without vectors or an embedder, ranking is
        keywords only, exactly as before.
        """
        if not message or not message.strip() or limit <= 0:
            return []

        query_lower = " ".join(message.split()).lower()
        semantic_scores = self._semantic_scores(message, semantic)
        ranked: list[tuple[float, CorpusUnit]] = []
        for unit in self.units:
            score = _score_unit(query_lower, unit) + semantic_scores.get(unit.id, 0.0)
            if score < MIN_SCORE:
                continue
            ranked.append((score, unit))

        ranked.sort(key=lambda item: (-item[0], item[1].id))
        chunks = [
            GroundingChunk(id=unit.id, topic=unit.technique, content=unit.render())
            for _, unit in ranked[:limit]
        ]
        logger.info("grounding_retrieve hits=%s semantic=%s", len(chunks), bool(semantic_scores))
        return chunks
