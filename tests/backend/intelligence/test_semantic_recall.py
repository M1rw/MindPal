"""Search by meaning: memory facts and library files found without shared words."""

import pytest

from backend.domain.files.library import COLLECTION, LibraryService
from backend.domain.files.lookup import search
from backend.domain.memory.graph import MemoryAtom, MemoryGraphService
from backend.domain.memory.vectors import COLLECTION as VECTORS, MemoryVectors
from backend.domain.voice.services.recall import VoiceRecallService
from backend.infra.store.store import InMemoryStore

USER = "usr_semantic_owner"

# Words that mean the same thing land on the same axis, in either language.
CONCEPTS = {
    "work": ("work", "job", "manager", "boss", "meeting", "office", "الدوام", "مديري", "الشغل"),
    "study": ("exam", "study", "test", "university", "الامتحان", "ادرس"),
    "home": ("lease", "rent", "rental", "flat", "apartment", "landlord", "tenant", "pets", "cat"),
    "family": ("sister", "brother", "mom", "family", "اختي", "امي"),
}


class ConceptEmbedder:
    def __init__(self):
        self.calls = 0

    def embed(self, texts, *, task):
        self.calls += 1
        out = []
        for text in texts:
            lowered = text.lower()
            vec = [sum(1.0 for word in words if word in lowered) for words in CONCEPTS.values()]
            out.append(vec if any(vec) else [0.01] * len(CONCEPTS))
        return out


@pytest.fixture()
def embedder(monkeypatch):
    from backend.domain.files import lookup
    from backend.domain.memory import vectors

    fake = ConceptEmbedder()
    for module in (vectors, lookup):
        monkeypatch.setattr(module, "get_embedder", lambda: fake)
    return fake


@pytest.fixture()
def store():
    store = InMemoryStore()
    store.set_document("voice_sessions", "vs_mine", {"user_id_hash": USER, "status": "active"})
    return store


def _facts(store):
    service = MemoryGraphService(store=store)
    graph, _ = service.merge_atoms(USER, [
        MemoryAtom(id="a1", category="work", value="My manager yelled at me in the meeting"),
        MemoryAtom(id="a2", category="people", value="Sister Nour lives in Cairo"),
        MemoryAtom(id="a3", category="studies", value="Final exam on Monday"),
    ])
    return service, graph


def test_facts_are_indexed_with_fingerprints_not_their_words(store, embedder):
    _, graph = _facts(store)
    assert MemoryVectors(store).refresh(USER, graph.atoms) == 3
    entries = store.get_document(VECTORS, USER)["vectors"]
    assert set(entries) == {"a1", "a2", "a3"}
    assert all(set(entry) == {"fp", "vec"} for entry in entries.values()), "no fact text in the index"
    calls = embedder.calls
    assert MemoryVectors(store).refresh(USER, graph.atoms) == 0 and embedder.calls == calls, "nothing to redo"


def test_voice_memory_lookup_finds_meaning_without_shared_words(store, embedder):
    _, graph = _facts(store)
    MemoryVectors(store).refresh(USER, graph.atoms)
    service = VoiceRecallService(store=store, memory=MemoryGraphService(store=store))
    result = service.recall(user_id_hash=USER, session_id="vs_mine", tool="search_memory", query="stressed about the office")
    lines = [line for line in result.result.splitlines() if line.startswith("- ")]
    assert lines[0] == "- My manager yelled at me in the meeting"


def test_arabic_query_finds_an_english_fact(store, embedder):
    _, graph = _facts(store)
    MemoryVectors(store).refresh(USER, graph.atoms)
    scores = MemoryVectors(store).scores(USER, "تعبت من الدوام ومديري")
    assert max(scores, key=scores.get) == "a1"


def test_deleting_or_editing_a_fact_drops_its_vector_at_once(store, embedder):
    from backend.domain.memory.consolidation import MemoryConsolidationService
    from backend.domain.memory.editing import MemoryEditor

    service, graph = _facts(store)
    MemoryVectors(store).refresh(USER, graph.atoms)
    editor = MemoryEditor(service, MemoryConsolidationService(store, memory=service))
    editor.delete_atom(USER, "a2")
    editor.edit_atom(USER, "a3", "Final exam moved to Wednesday")
    left = store.get_document(VECTORS, USER)["vectors"]
    assert "a2" not in left, "deleted fact"
    assert "a3" not in left, "rewritten fact waits for a fresh vector"
    assert "a1" in left


def test_without_an_embedder_everything_stays_keyword_only(store, monkeypatch):
    from backend.domain.memory import vectors

    monkeypatch.setattr(vectors, "get_embedder", lambda: None)
    _, graph = _facts(store)
    assert MemoryVectors(store).refresh(USER, graph.atoms) == 0
    assert MemoryVectors(store).scores(USER, "office") == {}


def test_library_file_found_by_meaning(store, embedder):
    from backend.domain.files.contracts import Digest
    from backend.domain.files.lookup import file_vectors

    digest = Digest.model_validate({
        "version": 1, "kind": "pdf", "content": "text", "name": "doc.pdf", "title": "Agreement", "summary": "Signed agreement",
        "language": "en", "total_pages": 1,
        "pages": [{"n": 1, "kind": "text", "text": "The tenant may keep one cat in the flat.", "description": ""}],
    })
    vectors = file_vectors("doc.pdf", digest)
    assert vectors and len(vectors["pages"]) == 1
    store.set_document(COLLECTION, f"{USER}:f1", {
        "id": "f1", "name": "doc.pdf", "status": "ready", "digest": digest.model_dump(), "vecs": vectors,
    })
    hits = search(LibraryService(store=store), USER, "rules about animals at my apartment")
    assert [hit.name for hit in hits] == ["doc.pdf"]
