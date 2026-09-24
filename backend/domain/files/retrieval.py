"""Which pages of a file to put in front of the model for this question.

A short file goes in whole. A long one is scored page by page against the
question (word overlap, in any script) and packed into a character budget,
always keeping pages the person names ("page 12", "p. 3", "صفحة ٣") and the
first page, which usually says what the document is.
"""

from __future__ import annotations

import math
import re
from typing import Dict, List, Sequence, Set

from backend.domain.files.contracts import Digest, PageDigest

_WORD = re.compile(r"[^\W_]{3,}", re.UNICODE)
_PAGE_REF = re.compile(r"(?:\bpages?\b|\bp\.|\bpg\.?|صفحة|صفحه|الصفحة)\s*([0-9٠-٩]{1,4})", re.IGNORECASE)
_ARABIC_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789")
_STOP = frozenset(
    "the and for with that this what from about have does into your their there which when where would could "
    "should please tell show explain summary summarize summarise page pages file document pdf image photo".split()
)


def _words(text: str) -> List[str]:
    return [w for w in (m.group(0).lower() for m in _WORD.finditer(text or "")) if w not in _STOP]


def named_pages(question: str) -> Set[int]:
    pages: Set[int] = set()
    for match in _PAGE_REF.finditer(question or ""):
        try:
            pages.add(int(match.group(1).translate(_ARABIC_DIGITS)))
        except ValueError:
            continue
    return pages


def page_block(page: PageDigest, *, paged: bool) -> str:
    head = f"[p. {page.n}]" if paged else ""
    parts = [head] if head else []
    if page.text:
        parts.append(page.text)
    if page.description:
        parts.append(f"(What it shows: {page.description})")
    return "\n".join(parts)


def select_pages(digest: Digest, question: str, budget_chars: int) -> List[PageDigest]:
    pages = [p for p in digest.pages if p.text or p.description]
    if not pages:
        return []
    total = sum(len(p.text) + len(p.description) for p in pages)
    if total <= budget_chars:
        return pages
    wanted = named_pages(question)
    query = _words(question)
    doc_freq: Dict[str, int] = {}
    page_words: Dict[int, List[str]] = {}
    for page in pages:
        words = _words(f"{page.text} {page.description}")
        page_words[page.n] = words
        for word in set(words):
            doc_freq[word] = doc_freq.get(word, 0) + 1
    count = len(pages)

    def score(page: PageDigest) -> float:
        if page.n in wanted:
            return 1e9
        words = page_words[page.n]
        if not words:
            return 0.0
        value = 0.0
        for word in set(query):
            hits = words.count(word)
            if hits:
                idf = math.log(1 + count / (1 + doc_freq.get(word, 0)))
                value += idf * (1 + math.log(hits))
        if page.n == pages[0].n:
            value += 0.5  # the first page usually says what the document is
        return value

    ranked = sorted(pages, key=lambda p: (-score(p), p.n))
    chosen: List[PageDigest] = []
    used = 0
    for page in ranked:
        size = len(page.text) + len(page.description)
        if used + size > budget_chars:
            if page.n in wanted and used < budget_chars:
                # Never drop a page they asked for: trim it instead.
                room = max(400, budget_chars - used)
                chosen.append(page.model_copy(update={"text": page.text[:room]}))
                used = budget_chars
            continue
        chosen.append(page)
        used += size
    return sorted(chosen, key=lambda p: p.n)


def render_file_context(digests: Sequence[Digest], question: str, budget_chars: int = 24000) -> str:
    """The files block for the system prompt: each file, then its chosen pages."""
    if not digests:
        return ""
    share = max(2000, budget_chars // len(digests))
    blocks: List[str] = []
    for index, digest in enumerate(digests, start=1):
        paged = digest.kind == "pdf"
        chosen = select_pages(digest, question, share)
        label = digest.name or digest.title or f"file {index}"
        size = f"{digest.total_pages} pages" if paged else f"image ({digest.content})"
        header = f'<file index="{index}" name="{label}" kind="{digest.kind}" size="{size}">'
        body = "\n\n".join(page_block(p, paged=paged) for p in chosen) or "(nothing readable)"
        omitted = digest.total_pages - len(chosen) if paged else 0
        tail = f"\n(Other pages not shown here: {omitted}. They exist; ask to look if needed.)" if omitted > 0 else ""
        blocks.append(f"{header}\n{body}{tail}\n</file>")
    return "\n\n".join(blocks)
