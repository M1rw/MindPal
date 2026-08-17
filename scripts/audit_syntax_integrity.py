#!/usr/bin/env python3
"""Deterministic MindPal source syntax and static-integrity audit."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# The audit targets executable application and validation code. `scratch/` is a
# tracked historical workspace containing UTF-16 snapshots, not shipped source.
SOURCE_ROOTS = (ROOT / "backend", ROOT / "frontend", ROOT / "tests", ROOT / "scripts")
EXCLUDED_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", "dist", ".pytest_cache", "scratch"}
JS_SUFFIXES = {".js", ".mjs", ".cjs"}
PY_SUFFIXES = {".py"}
IMPORT_RE = re.compile(r"(?:import|export)\s+(?:[^'\";]+?\s+from\s+)?['\"](\.{1,2}/[^'\"]+)['\"]")


def source_files(suffixes: set[str]):
    for source_root in SOURCE_ROOTS:
        if not source_root.exists():
            continue
        for path in source_root.rglob("*"):
            if any(part in EXCLUDED_DIRS for part in path.parts):
                continue
            if path.is_file() and path.suffix in suffixes:
                yield path


def audit_python(failures: list[str]) -> int:
    checked = 0
    for path in source_files(PY_SUFFIXES):
        checked += 1
        result = subprocess.run(
            [sys.executable, "-m", "py_compile", str(path)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        if result.returncode:
            failures.append(f"PYTHON SYNTAX {path.relative_to(ROOT)}\n{result.stderr.strip()}")
    return checked


def audit_javascript(failures: list[str]) -> int:
    checked = 0
    for path in source_files(JS_SUFFIXES):
        checked += 1
        result = subprocess.run(
            ["node", "--check", str(path)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        if result.returncode:
            failures.append(f"JAVASCRIPT SYNTAX {path.relative_to(ROOT)}\n{result.stderr.strip()}")
    return checked


def audit_json(failures: list[str]) -> int:
    checked = 0
    for path in source_files({".json"}):
        checked += 1
        try:
            json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            failures.append(f"JSON {path.relative_to(ROOT)}\n{exc}")
    return checked


def audit_relative_imports(failures: list[str]) -> int:
    checked = 0
    for path in source_files(JS_SUFFIXES):
        try:
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            failures.append(f"READ {path.relative_to(ROOT)}\n{exc}")
            continue
        for reference in IMPORT_RE.findall(content):
            checked += 1
            target = (path.parent / reference).resolve()
            candidates = [target]
            if not target.suffix:
                candidates.extend(target.with_suffix(suffix) for suffix in JS_SUFFIXES)
                candidates.extend(target / f"index{suffix}" for suffix in JS_SUFFIXES)
            if not any(candidate.is_file() for candidate in candidates):
                failures.append(
                    f"UNRESOLVED IMPORT {path.relative_to(ROOT)} -> {reference}"
                )
    return checked


def main() -> int:
    failures: list[str] = []
    summary = {
        "python_files": audit_python(failures),
        "javascript_files": audit_javascript(failures),
        "json_files": audit_json(failures),
        "relative_imports": audit_relative_imports(failures),
        "failures": failures,
    }
    print(json.dumps(summary, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
