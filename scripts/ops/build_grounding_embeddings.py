"""Build vectors for the wellness guidance library so retrieval can match by meaning.

    python scripts/ops/build_grounding_embeddings.py          # needs GEMINI_API_KEY
    python scripts/ops/build_grounding_embeddings.py --check  # exit 1 if stale or missing

Writes data/clinical_frameworks/embeddings.json. Each vector carries a hash of
the technique's text; the app ignores vectors whose technique has changed, so
rerun this after editing the library. One embedding call per technique.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)

    from backend.domain.grounding.grounding import EMBEDDINGS_FILE, load_corpus_units, unit_embedding_text, unit_fingerprint
    from backend.infra.llm.embeddings import EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, compact, get_embedder

    units = load_corpus_units()
    existing = {}
    if EMBEDDINGS_FILE.exists():
        existing = json.loads(EMBEDDINGS_FILE.read_text(encoding="utf-8")).get("units", {})
    stale = [u for u in units if existing.get(u.id, {}).get("hash") != unit_fingerprint(u)]
    if args.check:
        print(f"{len(units)} techniques, {len(stale)} missing or stale vectors")
        return 1 if stale else 0
    if not stale:
        print("All vectors are current.")
        return 0

    embedder = get_embedder()
    if embedder is None:
        print("No embedder: set GEMINI_API_KEY (and leave MINDPAL_SEMANTIC_SEARCH on).", file=sys.stderr)
        return 1
    vectors = embedder.embed([unit_embedding_text(u) for u in stale], task="RETRIEVAL_DOCUMENT")
    if not vectors or len(vectors) != len(stale):
        print("Embedding call failed; nothing written.", file=sys.stderr)
        return 1
    units_out = {u.id: existing[u.id] for u in units if u.id in existing and u not in stale}
    for unit, vector in zip(stale, vectors):
        units_out[unit.id] = {"hash": unit_fingerprint(unit), "vector": compact(vector)}
    EMBEDDINGS_FILE.write_text(
        json.dumps({"model": EMBEDDING_MODEL, "dimensions": EMBEDDING_DIMENSIONS, "units": units_out}, indent=1) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {len(stale)} vectors ({len(units_out)} total) to {EMBEDDINGS_FILE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
