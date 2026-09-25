"""Memory searchable by meaning, not only by shared words.

"When I was stressed about work" should find "My manager yelled at me in the
meeting", in Arabic as in English. Each saved fact gets an embedding, kept in
its own document (`memory_vectors`, one per person, keyed by atom id) so the
memory graph, its API and exports stay exactly as they were. The vectors are
a derived index: deleted with the account, rebuilt from the facts at will.

Best effort everywhere: no key, a provider error or a paused embedder leaves
the index as it is and every caller keeps its keyword ranking.
"""

from __future__ import annotations

import hashlib
import logging
from typing import Any, Dict, Iterable, List, Optional, Sequence

from backend.infra.llm.embeddings import compact, cosine, get_embedder

logger = logging.getLogger("mindpal.memory")

COLLECTION = "memory_vectors"
# One embedding request carries at most this many facts.
BATCH = 32
# gemini-embedding-001 at 256 dimensions scores unrelated text around 0.60-0.65
# and a real match 0.74-0.80 (measured on English and Arabic facts and queries).
# Below the floor counts as unrelated; the span rescales a match to 0..1 like
# the keyword share.
SEMANTIC_FLOOR = 0.66
SEMANTIC_SPAN = 0.14


def meaning_score(similarity: float) -> float:
    return min(1.0, max(0.0, (similarity - SEMANTIC_FLOOR) / SEMANTIC_SPAN))


def atom_text(atom: Any) -> str:
    return f"{getattr(atom, 'category', '')}: {getattr(atom, 'value', '')}".strip(": ")


def _fingerprint(text: str) -> str:
    """Detects a changed fact without keeping its words in the index."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


class MemoryVectors:
    def __init__(self, store: Any) -> None:
        self.store = store

    def _load(self, user: str) -> Dict[str, Dict[str, Any]]:
        doc = self.store.get_document(COLLECTION, user) or {}
        vectors = doc.get("vectors")
        return vectors if isinstance(vectors, dict) else {}

    def refresh(self, user: str, atoms: Sequence[Any], *, limit: int = BATCH * 2) -> int:
        """Embed facts that have no vector (or whose text changed) and drop vectors of
        facts that are gone. Returns how many were embedded."""
        embedder = get_embedder()
        if embedder is None or not user:
            return 0
        known = self._load(user)
        live = {atom.id: atom_text(atom) for atom in atoms if getattr(atom, "value", "").strip()}
        stale = [aid for aid, text in live.items() if (known.get(aid) or {}).get("fp") != _fingerprint(text)][:limit]
        pruned = {aid: entry for aid, entry in known.items() if aid in live and entry.get("fp") == _fingerprint(live[aid])}
        embedded = 0
        for start in range(0, len(stale), BATCH):
            ids = stale[start : start + BATCH]
            vectors = embedder.embed([live[aid] for aid in ids], task="RETRIEVAL_DOCUMENT")
            if not vectors or len(vectors) != len(ids):
                break
            for aid, vector in zip(ids, vectors):
                pruned[aid] = {"fp": _fingerprint(live[aid]), "vec": compact(vector)}
                embedded += 1
        if embedded or len(pruned) != len(known):
            self.store.set_document(COLLECTION, user, {"user_id_hash": user, "vectors": pruned})
        return embedded

    def sync(self, user: str, atoms: Sequence[Any]) -> None:
        """Drop vectors of facts that were deleted or rewritten. No embedding call."""
        known = self._load(user)
        if not known:
            return
        live = {atom.id: _fingerprint(atom_text(atom)) for atom in atoms}
        kept = {aid: entry for aid, entry in known.items() if live.get(aid) == entry.get("fp")}
        if len(kept) != len(known):
            self.store.set_document(COLLECTION, user, {"user_id_hash": user, "vectors": kept})

    def scores(self, user: str, query: str, atom_ids: Optional[Iterable[str]] = None) -> Dict[str, float]:
        """Meaning match of each fact to `query`, 0..1 (0 = unrelated). Empty when unavailable."""
        embedder = get_embedder()
        if embedder is None or not query.strip():
            return {}
        known = self._load(user)
        if not known:
            return {}
        wanted = set(atom_ids) if atom_ids is not None else None
        vectors = embedder.embed([query], task="RETRIEVAL_QUERY")
        if not vectors:
            return {}
        query_vec = vectors[0]
        out: Dict[str, float] = {}
        for aid, entry in known.items():
            if wanted is not None and aid not in wanted:
                continue
            vec = entry.get("vec") if isinstance(entry, dict) else None
            if isinstance(vec, list) and vec:
                out[aid] = meaning_score(cosine(query_vec, vec))
        return out


def refresh_quietly(store: Any, user: str, atoms: Sequence[Any]) -> None:
    """refresh() that never raises: memory writes must not fail because of the index."""
    try:
        MemoryVectors(store).refresh(user, atoms)
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("memory_vectors_refresh_failed error=%s", type(exc).__name__)


def best_first(atoms: List[Any], lexical: Dict[str, float], semantic: Dict[str, float]) -> List[Any]:
    """Atoms ordered by max(keyword share, meaning match); ties keep their order."""
    return sorted(
        atoms,
        key=lambda atom: -max(lexical.get(atom.id, 0.0), semantic.get(atom.id, 0.0)),
    )
