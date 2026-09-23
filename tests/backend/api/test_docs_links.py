# tests/backend/api/test_docs_links.py - documentation must point at things that exist
"""Stale docs are worse than none. Every relative link and every code path
mentioned in the README and docs/ must resolve in the repository."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
DOCS = [ROOT / "README.md", *sorted((ROOT / "docs").rglob("*.md"))]

_LINK = re.compile(r"\]\(([^)#\s]+)(?:#[^)]*)?\)")
_CODE_PATH = re.compile(r"`([A-Za-z0-9_./-]+/[A-Za-z0-9_.-]+\.(?:py|ts|tsx|mjs|json|yaml|yml|sql|md|toml|lock|txt))`")
# Short paths in the docs are relative to these roots (e.g. `domain/memory/graph.py`).
_CODE_ROOTS = (ROOT, ROOT / "backend", ROOT / "frontend" / "src", ROOT / "tests")


def _resolves(path: str) -> bool:
    if any(ch in path for ch in "*<>{}"):
        return True  # patterns and placeholders, not concrete files
    return any((root / path).exists() for root in _CODE_ROOTS)


@pytest.mark.parametrize("doc", DOCS, ids=lambda p: str(p.relative_to(ROOT)))
def test_doc_links_and_code_paths_exist(doc: Path) -> None:
    text = doc.read_text(encoding="utf-8")
    missing: list[str] = []
    for target in _LINK.findall(text):
        if target.startswith(("http://", "https://", "mailto:")):
            continue
        if not (doc.parent / target).exists():
            missing.append(f"link {target}")
    for path in _CODE_PATH.findall(text):
        if not _resolves(path):
            missing.append(f"code path {path}")
    assert not missing, f"{doc.relative_to(ROOT)} references missing files: {missing}"


def test_docs_are_few_and_each_is_listed_in_the_index() -> None:
    index = (ROOT / "docs" / "README.md").read_text(encoding="utf-8")
    for doc in DOCS:
        if doc.name == "README.md":
            continue
        assert doc.name in index, f"{doc.relative_to(ROOT)} is not linked from docs/README.md"
