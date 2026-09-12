# backend/domain/release/changelog.py

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
CHANGELOG_PATH = ROOT / "contracts" / "changelog.json"


def load_changelog() -> dict[str, Any]:
    return json.loads(CHANGELOG_PATH.read_text(encoding="utf-8"))


def current_version() -> str:
    version = load_changelog().get("current_version")
    if not isinstance(version, str) or not version:
        raise RuntimeError("contracts/changelog.json missing current_version")
    return version
