# backend/features/rag/corpus_loader.py

"""
Corpus loader for curated YAML wellness grounding units.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import yaml

from backend.core.security import sanitize_text
from .schemas import GroundingUnit

logger = logging.getLogger(__name__)

DEFAULT_CORPUS_DIR = Path(__file__).resolve().parents[2] / "rag" / "corpus"


def load_corpus(corpus_dir: Path | None = None) -> list[GroundingUnit]:
    directory = corpus_dir or DEFAULT_CORPUS_DIR
    units: list[GroundingUnit] = []
    if not directory.exists() or not directory.is_dir():
        return units

    for filepath in sorted(directory.glob("*.yaml")):
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f)
            if not isinstance(data, dict):
                continue
            category = str(data.get("category") or filepath.stem)
            raw_units = data.get("units") or data.get("grounding_units") or []
            if isinstance(raw_units, list):
                for item in raw_units:
                    if isinstance(item, dict):
                        unit = _parse_grounding_unit(item, category=category, source=filepath.name)
                        if unit:
                            units.append(unit)
        except Exception as exc:
            logger.warning("corpus_load_failed file=%s error=%s", filepath.name, type(exc).__name__)

    return units


def _parse_grounding_unit(data: dict[str, Any], *, category: str, source: str) -> GroundingUnit | None:
    grounding_id = sanitize_text(str(data.get("id") or data.get("grounding_id") or ""), 80)
    technique = sanitize_text(str(data.get("technique") or data.get("title") or ""), 120)
    if not grounding_id or not technique:
        return None

    triggers = tuple(sanitize_text(str(t), 120) for t in data.get("trigger_terms", []) if str(t).strip())
    instructions = tuple(sanitize_text(str(i), 500) for i in data.get("instructions", []) if str(i).strip())
    contraindications = tuple(sanitize_text(str(c), 300) for c in data.get("contraindications", []) if str(c).strip())
    response_style = tuple(sanitize_text(str(s), 120) for s in data.get("response_style", []) if str(s).strip())
    tags = tuple(sanitize_text(str(t), 80) for t in data.get("tags", []) if str(t).strip())
    confidence = float(data.get("confidence_weight", 1.0))

    return GroundingUnit(
        grounding_id=grounding_id,
        category=category,
        technique=technique,
        trigger_terms=triggers,
        instructions=instructions,
        contraindications=contraindications,
        response_style=response_style,
        source=source,
        tags=tags,
        confidence_weight=confidence,
    )
