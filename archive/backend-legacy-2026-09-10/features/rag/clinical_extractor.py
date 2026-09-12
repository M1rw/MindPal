# backend/features/rag/clinical_extractor.py

"""
Clinical framework entity and concept extractor.
"""

from __future__ import annotations

import re
from typing import Any

from backend.core.security import sanitize_text

_CLINICAL_TERMS: dict[str, tuple[str, ...]] = {
    "cbt": ("thought record", "distortion", "catastrophizing", "all or nothing", "core belief", "evidence"),
    "dbt": ("stop skill", "tipp", "urge surfing", "radical acceptance", "wise mind", "distress tolerance"),
    "act": ("defusion", "expansion", "values", "committed action", "observing self", "acceptance"),
    "somatic": ("grounding", "body scan", "polyvagal", "breath", "nervous system", "orienting"),
}


def extract_clinical_concepts(text: str) -> list[dict[str, Any]]:
    lowered = sanitize_text(text, 1_000).lower()
    matches: list[dict[str, Any]] = []

    for framework, terms in _CLINICAL_TERMS.items():
        found = [t for t in terms if t in lowered]
        if found:
            matches.append({
                "framework": framework.upper(),
                "matched_terms": found,
                "confidence": min(1.0, 0.4 + (0.2 * len(found))),
            })

    return matches
