"""Daily file allowances: new files read, and pages sent to a vision model.

Counted per account, or per network for guests (like dictation), in one
transactional document per subject per day. Pages read on the device (PDF text
layers) and digests served from cache cost nothing: only vision calls are
metered, because only they are provider calls.
"""

from __future__ import annotations

import hashlib
import time
from typing import Any, Dict, Optional

from backend.core.errors import AppError
from backend.domain.files.contracts import tier
from backend.infra.store.store import StoreUnavailable, get_store

_COLLECTION = "file_allowance"
_MAX_TRACKED_HASHES = 200


class FileAllowance:
    def __init__(self, store: Any = None, clock: Any = time.time) -> None:
        self._store = store
        self._clock = clock

    @property
    def store(self) -> Any:
        return self._store if self._store is not None else get_store()

    def _doc_id(self, subject: str) -> tuple[str, int]:
        day = int(self._clock() // 86400)
        return hashlib.sha256(f"{subject}:{day}".encode("utf-8")).hexdigest()[:40], day

    def usage(self, subject: str, *, signed_in: bool) -> Dict[str, int]:
        doc_id, _day = self._doc_id(subject)
        try:
            doc = self.store.get_document(_COLLECTION, doc_id) or {}
        except StoreUnavailable:
            doc = {}
        limits = tier(signed_in)
        files = len(doc.get("hashes") or [])
        pages = int(doc.get("vision_pages", 0))
        return {
            "files_used": files,
            "files_limit": int(limits["files_per_day"]),
            "vision_pages_used": pages,
            "vision_pages_limit": int(limits["vision_pages_per_day"]),
        }

    def take(self, subject: str, *, signed_in: bool, file_hash: str, vision_pages: int) -> None:
        """Count a file (once per day per hash) and its vision pages, or refuse."""
        limits = tier(signed_in)
        max_files = int(limits["files_per_day"])
        max_pages = int(limits["vision_pages_per_day"])
        doc_id, day = self._doc_id(subject)

        def mutate(current: Optional[Dict[str, Any]], write: Any) -> Optional[str]:
            hashes = list((current or {}).get("hashes") or [])
            pages = int((current or {}).get("vision_pages", 0))
            is_new = file_hash not in hashes
            if is_new and len(hashes) >= max_files:
                return "files"
            if vision_pages and pages + vision_pages > max_pages:
                return "pages"
            if is_new:
                hashes = (hashes + [file_hash])[-_MAX_TRACKED_HASHES:]
            write({"hashes": hashes, "vision_pages": pages + vision_pages, "expires_at": (day + 2) * 86400})
            return None

        try:
            refused = self.store.transact(_COLLECTION, doc_id, mutate)
        except StoreUnavailable:
            raise AppError("unavailable", "Reading files is briefly unavailable. Please try again.")
        if refused == "files":
            more = "" if signed_in else " Sign in for more."
            raise AppError("rate_limited", f"You've added {max_files} files today. More tomorrow.{more}")
        if refused == "pages":
            more = "" if signed_in else " Sign in for more."
            raise AppError(
                "rate_limited",
                f"That's today's limit for reading images and scanned pages ({max_pages}).{more}",
            )
