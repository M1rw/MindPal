# tests/backend/intelligence/test_memory_corrections.py - corrections reach every derived surface
"""Audit MP-14 and MP-10.

MP-14: correcting "Lives in Paris" to "Lives in Cairo" left the AI summary and
       digests saying Paris; a summary the person wrote was hidden behind an
       older AI one.
MP-10: two writers that read the same graph each wrote their own copy, and the
       second erased the first's facts.
"""

from __future__ import annotations

from backend.domain.memory.consolidation import JOURNAL_COLLECTION, MemoryConsolidationService
from backend.domain.memory.editing import MemoryEditor, summary_payload
from backend.domain.memory.graph import MemoryAtom, MemoryGraphService
from backend.infra.store.providers.memory import InMemoryStore

USER = "usr_corrections"


def _setup():
    store = InMemoryStore()
    memory = MemoryGraphService(store)
    memory.merge_atoms(USER, [MemoryAtom(id="profile:city", category="profile", value="Lives in Paris")])
    graph = memory.get_memory_graph(USER)
    graph.narrative = "Lives in Paris and loves the Seine."
    memory.save_memory_graph(graph)
    store.set_document(JOURNAL_COLLECTION, USER, {"user_id_hash": USER, "turns": [], "digests": [
        {"at": 1.0, "text": "They talked about life in Paris."},
        {"at": 2.0, "text": "They talked about work."},
    ]})
    editor = MemoryEditor(memory, MemoryConsolidationService(store, memory=memory))
    return store, memory, editor


def test_a_patch_correction_forgets_the_old_wording_everywhere() -> None:
    store, memory, editor = _setup()
    graph = editor.edit_atom(USER, "profile:city", "Lives in Cairo")
    assert [a.value for a in graph.atoms] == ["Lives in Cairo"]
    assert graph.narrative == ""
    digests = [d["text"] for d in store.get_document(JOURNAL_COLLECTION, USER)["digests"]]
    assert digests == ["They talked about work."]


def test_a_put_correction_under_the_same_id_is_treated_the_same() -> None:
    store, memory, editor = _setup()
    graph = editor.replace(USER, [{"id": "profile:city", "category": "profile", "value": "Lives in Cairo"}], None)
    assert graph.narrative == ""
    assert "Paris" not in " ".join(d["text"] for d in store.get_document(JOURNAL_COLLECTION, USER)["digests"])


def test_a_summary_the_person_writes_is_what_they_see() -> None:
    _store, _memory, editor = _setup()
    graph = editor.replace(USER, None, "I moved to Cairo last spring.")
    view = summary_payload(USER, graph)
    assert view == {**view, "summary": "I moved to Cairo last spring.", "source": "user"}


def test_two_writers_on_the_same_graph_both_keep_their_facts() -> None:
    """The second writer's change is re-run against the first's result, not its stale copy."""
    store = InMemoryStore()
    memory = MemoryGraphService(store)
    stale = memory.get_memory_graph(USER)  # what both writers read

    def first(graph):
        graph.atoms = graph.atoms + [MemoryAtom(id="people:sister", category="people", value="Sister is Noor")]

    memory.mutate_graph(USER, first)
    memory.merge_atoms(USER, [MemoryAtom(id="work:job", category="work", value="Works as a nurse")])
    values = sorted(a.value for a in memory.get_memory_graph(USER).atoms)
    assert values == ["Sister is Noor", "Works as a nurse"]
    assert stale.atoms == []
