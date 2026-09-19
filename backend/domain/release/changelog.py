# backend/domain/release/changelog.py — Release Changelog Domain

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, Any
from backend.infra.store.store import get_store

# A dismissal list is a handful of versions, not a growing log.
MAX_DISMISSED_VERSIONS = 50

CHANGELOG_PATH = Path(__file__).resolve().parents[3] / "contracts" / "changelog.json"


def current_version() -> str:
    changelog = ReleaseService().get_changelog()
    return changelog.get("current_version", "5.0.0")


class ReleaseService:
    """Release changelog and user dismissal domain logic."""

    def __init__(self) -> None:
        self.store = get_store()

    def get_changelog(self, user_id_hash: Optional[str] = None) -> Dict[str, Any]:
        data = {
            "product": "mindpal",
            "current_version": "5.0.0",
            "entries": [],
            "dismissed_versions": []
        }
        if CHANGELOG_PATH.exists():
            with open(CHANGELOG_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
        
        # No account key, no stored dismissals. The old code fell back to a
        # literal "anonymous" document, so one guest dismissing a release
        # dismissed it for every other signed-out visitor, on every device.
        dismissed: list[str] = []
        if user_id_hash:
            doc = self.store.get_document("changelog_dismissals", user_id_hash)
            if isinstance(doc, dict) and isinstance(doc.get("dismissed_versions"), list):
                dismissed = [str(v) for v in doc["dismissed_versions"]][-MAX_DISMISSED_VERSIONS:]
        data["dismissed_versions"] = dismissed
        return data

    def dismiss_changelog(self, user_id_hash: str, version: str) -> Dict[str, Any]:
        """Record a dismissal against one account. Requires a real storage key."""
        if not user_id_hash:
            return {"status": "skipped", "dismissed": False, "dismissed_version": version}
        doc = self.store.get_document("changelog_dismissals", user_id_hash)
        versions = doc.get("dismissed_versions") if isinstance(doc, dict) else None
        if not isinstance(versions, list):
            versions = []
        if version not in versions:
            versions.append(version)
            self.store.set_document(
                "changelog_dismissals",
                user_id_hash,
                {
                    "user_id_hash": user_id_hash,
                    "dismissed_versions": versions[-MAX_DISMISSED_VERSIONS:],
                },
            )
        return {"status": "success", "dismissed": True, "dismissed_version": version}
