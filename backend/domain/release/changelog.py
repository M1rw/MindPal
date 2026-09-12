# backend/domain/release/changelog.py — Release Changelog Domain

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, Any
from backend.infra.store.store import get_store

CHANGELOG_PATH = Path(__file__).resolve().parents[3] / "contracts" / "changelog.json"


def current_version() -> str:
    changelog = ReleaseService().get_changelog()
    return changelog.get("current_version", "5.0.0")


class ReleaseService:
    """Release changelog and user dismissal domain logic."""

    def __init__(self) -> None:
        self.store = get_store()

    def get_changelog(self) -> Dict[str, Any]:
        if CHANGELOG_PATH.exists():
            with open(CHANGELOG_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        return {
            "product": "mindpal",
            "current_version": "5.0.0",
            "entries": []
        }

    def dismiss_changelog(self, user_id_hash: str, version: str) -> Dict[str, Any]:
        doc = self.store.get_document("changelog_dismissals", user_id_hash) or {"dismissed_versions": []}
        if version not in doc["dismissed_versions"]:
            doc["dismissed_versions"].append(version)
            self.store.set_document("changelog_dismissals", user_id_hash, doc)
        return {"status": "success", "dismissed_version": version}
