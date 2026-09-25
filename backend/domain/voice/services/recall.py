# backend/domain/voice/recall.py — Memory and past-chat lookups for the live voice model

"""What MindPal can look up mid-call: the caller's memory graph, their saved chats and their library.

The Live model calls `search_memory` / `search_past_chats` as tools. The browser
holds the Gemini socket, so it relays the call here; this checks the call belongs
to the caller, searches only that caller's data, and returns a short plain-text
result the model can speak from. Guests get nothing.

Ranking is lexical and language-neutral: Unicode word tokens, plus character
bigrams for scripts written without spaces (Japanese, Chinese, Thai), plus a
recency boost. There is no vector store in the repo; embeddings can replace
`score` later without changing the tool contract.
"""

from __future__ import annotations

import re
import threading
import time
import unicodedata
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterable, List, Set

from backend.core.errors import AppError
from backend.configs.runtime import voice_runtime_config
from backend.configs.runtime import behavior_config
from backend.domain.memory.extract import can_persist_user_memory
from backend.domain.memory.graph import MemoryGraphService
from backend.infra.store.store import get_store

TOOLS = ("search_memory", "search_past_chats", "search_library")
VOICE_SESSION_COLLECTION = "voice_sessions"
CLOSED_STATUSES = {"torn_down", "crisis_freeze"}

_RECALL_CONFIG = voice_runtime_config()["recall"]
MEMORY_RESULT_CHARS = int(_RECALL_CONFIG["memory_result_chars"])
CHATS_RESULT_CHARS = int(_RECALL_CONFIG["chats_result_chars"])
MAX_CHAT_SESSIONS = int(_RECALL_CONFIG["max_chat_sessions"])
MAX_SNIPPETS = int(_RECALL_CONFIG["max_snippets"])
SNIPPET_CHARS = int(_RECALL_CONFIG["snippet_chars"])
MAX_QUERY_CHARS = int(_RECALL_CONFIG["max_query_chars"])
# Per call: a lookup is a moment of "let me think back", not a crawl.
MIN_INTERVAL_S = float(_RECALL_CONFIG["min_interval_seconds"])
MAX_PER_CALL = int(_RECALL_CONFIG["max_per_call"])

NOTHING_FOUND = behavior_config()["recall"]["nothing_found"]

_WORD = re.compile(r"\w+", re.UNICODE)
# Scripts that do not separate words with spaces.
_UNSPACED = re.compile("[぀-ヿ㐀-鿿฀-๿가-힯]")
# Very common words that would otherwise match everything. Tiny on purpose, and
# only a tie-breaker: ranking still works in languages not listed here.
_STOP = frozenset(behavior_config()["recall"]["stop_words"])


def tokens(text: str) -> Set[str]:
    """Comparable units of a text, in any script."""
    normalized = unicodedata.normalize("NFKC", text or "").casefold()
    out: Set[str] = set()
    for word in _WORD.findall(normalized):
        if _UNSPACED.search(word):
            chars = [c for c in word if not c.isspace()]
            out.update(a + b for a, b in zip(chars, chars[1:]))
            if len(chars) == 1:
                out.add(chars[0])
        elif len(word) > 1 and word not in _STOP:
            out.add(word)
    return out


def score(query: Set[str], text: str) -> float:
    """Share of the query found in the text, 0..1."""
    if not query:
        return 0.0
    found = query & tokens(text)
    return len(found) / len(query)


def _clip(text: str, limit: int) -> str:
    """Tidy spacing within lines, keep the line breaks, cut at `limit` characters."""
    lines = (" ".join(line.split()) for line in (text or "").splitlines())
    text = "\n".join(line for line in lines if line)
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


@dataclass
class RecallResult:
    result: str
    found: bool

    def as_dict(self) -> Dict[str, Any]:
        return {"result": self.result, "found": self.found}


class VoiceRecallService:
    def __init__(
        self,
        *,
        store: Any | None = None,
        memory: MemoryGraphService | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.store = store or get_store()
        self.memory = memory or MemoryGraphService(store=self.store)
        self._clock = clock
        self._lock = threading.Lock()
        self._calls: Dict[str, List[float]] = {}

    def recall(self, *, user_id_hash: str, session_id: str, tool: str, query: str) -> RecallResult:
        if tool not in TOOLS:
            raise AppError("payload_invalid", "Unknown recall tool.")
        self._own_open_session(user_id_hash, session_id)
        if not can_persist_user_memory(user_id_hash):
            return RecallResult(NOTHING_FOUND, False)
        if not self._admit(session_id):
            return RecallResult("Too many lookups in a row. Answer from what you already know.", False)
        text = _clip(query, MAX_QUERY_CHARS)
        if tool == "search_memory":
            return self._search_memory(user_id_hash, text)
        if tool == "search_library":
            return self._search_library(user_id_hash, text)
        return self._search_chats(user_id_hash, text)

    # ------------------------------------------------------------ searches

    def _search_memory(self, user_id_hash: str, query: str) -> RecallResult:
        graph = self.memory.get_memory_graph(user_id_hash)
        wanted = tokens(query)
        ranked = sorted(graph.atoms, key=lambda atom: score(wanted, f"{atom.category} {atom.value}"), reverse=True)
        relevant = [atom for atom in ranked if score(wanted, f"{atom.category} {atom.value}") > 0]
        # With at most 16 atoms, the most relevant come first and the rest still help.
        chosen = relevant or ranked
        lines: List[str] = []
        if graph.narrative.strip():
            lines.append(f"Summary of past conversations: {graph.narrative.strip()}")
        elif graph.summary.strip() and not graph.summary_auto:
            lines.append(f"Summary: {graph.summary.strip()}")
        lines.extend(f"- {atom.value}" for atom in chosen)
        if not lines:
            return RecallResult(NOTHING_FOUND, False)
        return RecallResult(_clip("\n".join(lines), MEMORY_RESULT_CHARS), True)

    def _search_library(self, user_id_hash: str, query: str) -> RecallResult:
        from backend.domain.files.library import LibraryService
        from backend.domain.files.lookup import voice_result

        text, found = voice_result(LibraryService(store=self.store), user_id_hash, query)
        return RecallResult(text, True) if found else RecallResult(NOTHING_FOUND, False)

    def _digest_hits(self, user_id_hash: str, query: str, wanted: Set[str]) -> List[tuple[float, str]]:
        """Earlier conversations, compacted into digests, ranked by meaning when possible."""
        journal = self.store.get_document("memory_journal", user_id_hash) or {}
        digests = [d for d in journal.get("digests") or [] if isinstance(d, dict) and d.get("text")]
        if not digests:
            return []
        query_vector = None
        if any(isinstance(d.get("vec"), list) for d in digests):
            from backend.infra.llm.embeddings import get_embedder

            embedder = get_embedder()
            vectors = embedder.embed([query], task="RETRIEVAL_QUERY") if embedder else None
            query_vector = vectors[0] if vectors else None
        hits: List[tuple[float, str]] = []
        for digest in digests:
            text = str(digest["text"])
            relevance = score(wanted, text)
            if query_vector is not None and isinstance(digest.get("vec"), list):
                from backend.infra.llm.embeddings import cosine

                relevance = max(relevance, max(0.0, cosine(query_vector, digest["vec"]) - 0.5) * 2)
            if relevance <= 0:
                continue
            day = time.strftime("%Y-%m-%d", time.gmtime(float(digest.get("at") or 0)))
            hits.append((relevance, f"[{day} · earlier conversation] {_clip(text, SNIPPET_CHARS)}"))
        return hits

    def _search_chats(self, user_id_hash: str, query: str) -> RecallResult:
        wanted = tokens(query)
        if not wanted:
            return RecallResult(NOTHING_FOUND, False)
        docs = self.store.list_documents("chat_sessions", prefix=f"{user_id_hash}:")
        docs = sorted(docs, key=lambda d: str(d.get("updatedAt") or d.get("createdAt") or ""), reverse=True)
        docs = docs[:MAX_CHAT_SESSIONS]
        hits: List[tuple[float, str]] = []
        for rank, doc in enumerate(docs):
            recency = 1.0 - rank / max(1, len(docs)) * 0.3
            title = str(doc.get("title") or "Untitled chat")
            day = str(doc.get("updatedAt") or doc.get("createdAt") or "")[:10]
            for message in self._messages(doc):
                content = str(message.get("content") or "")
                relevance = score(wanted, content)
                if relevance <= 0:
                    continue
                who = "They said" if message.get("role") == "user" else "MindPal said"
                hits.append((relevance * recency, f'[{day} · "{_clip(title, 60)}"] {who}: {_clip(content, SNIPPET_CHARS)}'))
        hits.extend(self._digest_hits(user_id_hash, query, wanted))
        if not hits:
            return RecallResult(NOTHING_FOUND, False)
        hits.sort(key=lambda hit: hit[0], reverse=True)
        return RecallResult(_clip("\n".join(text for _, text in hits[:MAX_SNIPPETS]), CHATS_RESULT_CHARS), True)

    @staticmethod
    def _messages(doc: Dict[str, Any]) -> Iterable[Dict[str, Any]]:
        messages = doc.get("messages")
        return [m for m in messages if isinstance(m, dict)] if isinstance(messages, list) else []

    # ------------------------------------------------------------ guards

    def _own_open_session(self, user_id_hash: str, session_id: str) -> None:
        record = self.store.get_document(VOICE_SESSION_COLLECTION, session_id) if session_id else None
        if not record or record.get("user_id_hash") != user_id_hash:
            raise AppError("not_found", "That live voice session is not available.")
        if record.get("status") in CLOSED_STATUSES:
            raise AppError("not_found", "That live voice session has ended.")

    def _admit(self, session_id: str) -> bool:
        now = self._clock()
        with self._lock:
            stamps = self._calls.get(session_id, [])
            if stamps and now - stamps[-1] < MIN_INTERVAL_S:
                return False
            if len(stamps) >= MAX_PER_CALL:
                return False
            stamps.append(now)
            self._calls[session_id] = stamps
            return True

