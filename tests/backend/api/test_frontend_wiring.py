# tests/backend/api/test_frontend_wiring.py - every /api path the frontend calls is served
"""Scans frontend/src for '/api/...' literals (template parameters become a
wildcard segment) and matches each against the app's routes. A renamed or
removed route then fails here instead of as a 404 in someone's browser.
docs/wiring.md is the human map of the same links."""

from __future__ import annotations

import re
from pathlib import Path

from backend.main import create_app

ROOT = Path(__file__).resolve().parents[3]
LITERAL = re.compile(r"""['"`](/api/[A-Za-z0-9_\-/${}().]+?)(?:\?[^'"`]*)?['"`]""")
IGNORED_FILES = {"http.ts", "config.ts"}  # base-URL plumbing, not calls


def _frontend_paths() -> dict[str, set[str]]:
    found: dict[str, set[str]] = {}
    for path in (ROOT / "frontend" / "src").rglob("*.ts*"):
        if path.name in IGNORED_FILES:
            continue
        for match in LITERAL.finditer(path.read_text(encoding="utf-8")):
            raw = match.group(1)
            if raw.rstrip("/") == "/api":
                continue
            normalized = re.sub(r"\$\{[^}]*\}", "{param}", raw)
            found.setdefault(normalized, set()).add(path.relative_to(ROOT).as_posix())
    return found


def _route_patterns() -> list[re.Pattern[str]]:
    app = create_app(serve_frontend=False)
    patterns = []
    for route in app.routes:
        path = getattr(route, "path", "")
        if path.startswith("/api/"):
            patterns.append(re.compile("^" + re.sub(r"\{[^}]+\}", "[^/]+", path) + "$"))
    return patterns


def test_frontend_only_calls_served_routes() -> None:
    paths = _frontend_paths()
    assert len(paths) >= 20, f"scanner found too few calls: {sorted(paths)}"
    routes = _route_patterns()
    missing = {
        path: sorted(files)
        for path, files in paths.items()
        if not any(r.match(path.replace("{param}", "x")) for r in routes)
    }
    assert not missing, f"frontend calls routes the backend does not serve: {missing}"
