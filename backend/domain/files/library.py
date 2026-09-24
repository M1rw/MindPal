"""The library: an account's files, their digests, and where the bytes live.

One document per file in `library_files` ("<user id hash>:<file id>") holds
the metadata and the digest; the bytes (original, thumbnail, a few page
previews) sit in object storage under "<user id hash>/<file id>/". Uploads are
two-step: the browser asks for signed upload links, uploads straight to
storage, then completes the file with its digest. Completion checks the real
sizes in storage, so limits hold whatever the browser claimed.

Guests have no library here; theirs stays on their device.
"""

from __future__ import annotations

import logging
import re
import secrets
import time
from typing import Any, Dict, List, Optional

from backend.core.errors import AppError
from backend.domain.files.contracts import (
    IMAGE_TYPES,
    PDF_TYPE,
    Digest,
    LibraryUploadRequest,
    tier,
    valid_file_id,
)
from backend.infra.blob import BlobStore, BlobUnavailable, get_blob_store
from backend.infra.store.store import get_store

logger = logging.getLogger("mindpal.library")

COLLECTION = "library_files"
DIGEST_CACHE = "file_digests"
_PENDING_SECONDS = 3600
_PREVIEW = re.compile(r"^p\d+\.webp$")
_EXT = {
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
    "image/heic": "heic", "image/heif": "heif", PDF_TYPE: "pdf",
}


def _doc_id(user: str, file_id: str) -> str:
    return f"{user}:{file_id}"


def _public(doc: Dict[str, Any], *, with_digest: bool = False) -> Dict[str, Any]:
    out = {
        "id": doc["id"],
        "name": doc.get("name", ""),
        "mime": doc.get("mime", ""),
        "kind": doc.get("kind", ""),
        "size": int(doc.get("size", 0)),
        "pages": int(doc.get("pages", 1)),
        "content": (doc.get("digest") or {}).get("content", ""),
        "title": (doc.get("digest") or {}).get("title", ""),
        "summary": (doc.get("digest") or {}).get("summary", ""),
        "previews": int(doc.get("previews", 0)),
        "created_at": doc.get("created_at", 0),
    }
    if with_digest:
        out["digest"] = doc.get("digest")
    return out


class LibraryService:
    def __init__(self, store: Any = None, blobs: Optional[BlobStore] = None) -> None:
        self._store = store
        self._blobs = blobs

    @property
    def store(self) -> Any:
        return self._store if self._store is not None else get_store()

    @property
    def blobs(self) -> BlobStore:
        return self._blobs if self._blobs is not None else get_blob_store()

    # -- reads ---------------------------------------------------------------

    def _docs(self, user: str) -> List[Dict[str, Any]]:
        return [doc for _id, doc in self.store.iter_documents(COLLECTION, prefix=f"{user}:")]

    def _ready(self, user: str) -> List[Dict[str, Any]]:
        return [d for d in self._docs(user) if d.get("status") == "ready"]

    def usage(self, user: str) -> Dict[str, int]:
        ready = self._ready(user)
        limits = tier(True)
        return {
            "files": len(ready),
            "bytes": sum(int(d.get("size", 0)) for d in ready),
            "files_limit": int(limits["library_files"]),
            "bytes_limit": int(limits["library_bytes"]),
        }

    def list(self, user: str, query: str = "") -> Dict[str, Any]:
        docs = sorted(self._ready(user), key=lambda d: -float(d.get("created_at", 0)))
        needle = query.strip().lower()
        if needle:
            docs = [d for d in docs if needle in _searchable(d)]
        files = [_public(d) for d in docs]
        thumbs = self._sign([f"{user}/{d['id']}/thumb.webp" for d in docs])
        for item, url in zip(files, thumbs):
            item["thumb_url"] = url
        return {"files": files, "usage": self.usage(user)}

    def get(self, user: str, file_id: str) -> Dict[str, Any]:
        doc = self._require(user, file_id)
        out = _public(doc, with_digest=True)
        paths = [f"{user}/{file_id}/original.{doc.get('ext', 'bin')}", f"{user}/{file_id}/thumb.webp"]
        paths += [f"{user}/{file_id}/p{n}.webp" for n in range(1, int(doc.get("previews", 0)) + 1)]
        urls = self._sign(paths)
        out["url"], out["thumb_url"], out["preview_urls"] = urls[0], urls[1], urls[2:]
        return out

    def digests(self, user: str, file_ids: List[str]) -> Dict[str, Digest]:
        """Digests for a chat turn, by file id; unknown or unfinished files are left out."""
        out: Dict[str, Digest] = {}
        for file_id in dict.fromkeys(file_ids):
            doc = self.store.get_document(COLLECTION, _doc_id(user, file_id))
            if doc and doc.get("status") == "ready" and doc.get("digest"):
                out[file_id] = Digest.model_validate({**doc["digest"], "name": doc.get("name", "")})
        return out

    def _require(self, user: str, file_id: str) -> Dict[str, Any]:
        try:
            clean = valid_file_id(file_id)
        except ValueError:
            raise AppError("not_found", "That file isn't in your library.")
        doc = self.store.get_document(COLLECTION, _doc_id(user, clean))
        if not doc or doc.get("status") != "ready":
            raise AppError("not_found", "That file isn't in your library.")
        return doc

    def _sign(self, paths: List[str]) -> List[str]:
        out = []
        for path in paths:
            try:
                out.append(self.blobs.signed_download_url(path))
            except (BlobUnavailable, ValueError):
                out.append("")
        return out

    # -- writes --------------------------------------------------------------

    def start_upload(self, user: str, request: LibraryUploadRequest) -> Dict[str, Any]:
        mime = request.mime.split(";", 1)[0].strip().lower()
        if mime not in IMAGE_TYPES and mime != PDF_TYPE:
            raise AppError("payload_invalid", "Only images and PDFs can go in your library.")
        limits = tier(True)
        is_pdf = mime == PDF_TYPE
        max_bytes = int(limits["max_pdf_bytes" if is_pdf else "max_image_bytes"])
        if request.size > max_bytes:
            raise AppError("payload_invalid", f"Files can be up to {max_bytes // 1_000_000} MB.")
        if is_pdf and request.pages > int(limits["max_pdf_pages"]):
            raise AppError("payload_invalid", f"PDFs can be up to {limits['max_pdf_pages']} pages.")
        self._drop_stale_pending(user)
        # The same file again: hand back the one already there.
        for doc in self._ready(user):
            if doc.get("hash") == request.hash:
                return {"file_id": doc["id"], "existing": True, "uploads": {}}
        usage = self.usage(user)
        if usage["files"] >= usage["files_limit"]:
            raise AppError("rate_limited", f"Your library is full ({usage['files_limit']} files). Delete some to add more.")
        if usage["bytes"] + request.size > usage["bytes_limit"]:
            raise AppError("rate_limited", "Your library is out of space. Delete some files to add more.")
        file_id = f"f_{secrets.token_hex(8)}"
        ext = _EXT.get(mime, "bin")
        base = f"{user}/{file_id}"
        uploads = {"original": self.blobs.signed_upload_url(f"{base}/original.{ext}", mime)}
        uploads["thumb"] = self.blobs.signed_upload_url(f"{base}/thumb.webp", "image/webp")
        for n in range(1, request.previews + 1):
            uploads[f"p{n}"] = self.blobs.signed_upload_url(f"{base}/p{n}.webp", "image/webp")
        self.store.set_document(
            COLLECTION,
            _doc_id(user, file_id),
            {
                "id": file_id, "user_id_hash": user, "status": "pending", "name": request.name, "mime": mime,
                "kind": "pdf" if is_pdf else "image", "ext": ext, "hash": request.hash, "pages": request.pages,
                "previews": request.previews, "size": request.size, "created_at": time.time(),
            },
        )
        return {"file_id": file_id, "existing": False, "uploads": uploads}

    def complete(self, user: str, file_id: str, digest: Digest) -> Dict[str, Any]:
        try:
            clean = valid_file_id(file_id)
        except ValueError:
            raise AppError("not_found", "That upload isn't known.")
        key = _doc_id(user, clean)
        doc = self.store.get_document(COLLECTION, key)
        if not doc:
            raise AppError("not_found", "That upload isn't known.")
        if doc.get("status") == "ready":
            return _public(doc)
        stored = {obj.path: obj.size for obj in self.blobs.list_prefix(f"{user}/{clean}/")}
        original = stored.get(f"{user}/{clean}/original.{doc.get('ext', 'bin')}")
        if original is None:
            raise AppError("payload_invalid", "The file didn't finish uploading. Please try again.")
        limits = tier(True)
        max_bytes = int(limits["max_pdf_bytes" if doc.get("kind") == "pdf" else "max_image_bytes"])
        total = sum(stored.values())
        usage = self.usage(user)
        if original > max_bytes or usage["bytes"] + total > usage["bytes_limit"]:
            self.blobs.delete_paths(list(stored))
            self.store.delete_document(COLLECTION, key)
            raise AppError("payload_invalid", "That file is larger than your library allows.")
        doc.update(
            {
                "status": "ready",
                "size": total,
                "digest": digest.model_dump(),
                "pages": digest.total_pages,
                "previews": sum(1 for p in stored if _PREVIEW.match(p.rsplit("/", 1)[-1])),
            }
        )
        self.store.set_document(COLLECTION, key, doc)
        return _public(doc)

    def rename(self, user: str, file_id: str, name: str) -> Dict[str, Any]:
        doc = self._require(user, file_id)
        doc["name"] = name.strip()[:200]
        self.store.set_document(COLLECTION, _doc_id(user, doc["id"]), doc)
        return _public(doc)

    def delete(self, user: str, file_id: str) -> bool:
        doc = self._require(user, file_id)
        try:
            objects = self.blobs.list_prefix(f"{user}/{doc['id']}/")
            self.blobs.delete_paths([o.path for o in objects])
        except BlobUnavailable:
            raise AppError("unavailable", "Couldn't delete that file right now. Please try again.")
        return self.store.delete_document(COLLECTION, _doc_id(user, doc["id"]))

    def _drop_stale_pending(self, user: str) -> None:
        cutoff = time.time() - _PENDING_SECONDS
        for doc in self._docs(user):
            if doc.get("status") == "pending" and float(doc.get("created_at", 0)) < cutoff:
                try:
                    objects = self.blobs.list_prefix(f"{user}/{doc['id']}/")
                    self.blobs.delete_paths([o.path for o in objects])
                except BlobUnavailable:
                    continue
                self.store.delete_document(COLLECTION, _doc_id(user, doc["id"]))

    # -- account lifecycle ---------------------------------------------------

    def export(self, user: str) -> List[Dict[str, Any]]:
        """Everything stored about each file (the bytes themselves are downloaded from the library)."""
        return [dict(d) for d in self._docs(user)]

    def delete_account(self, user: str) -> int:
        """Every file, every byte, and every cached reading of this account."""
        removed = 0
        try:
            objects = self.blobs.list_prefix(f"{user}/")
            self.blobs.delete_paths([o.path for o in objects])
        except BlobUnavailable:
            logger.error("library_delete_blobs_failed user=%s", user[:12])
            raise
        for doc_id, _doc in list(self.store.iter_documents(COLLECTION, prefix=f"{user}:")):
            if self.store.delete_document(COLLECTION, doc_id):
                removed += 1
        for doc_id, _doc in list(self.store.query_documents(DIGEST_CACHE, "user_id_hash", user)):
            self.store.delete_document(DIGEST_CACHE, doc_id)
        return removed


def _searchable(doc: Dict[str, Any]) -> str:
    digest = doc.get("digest") or {}
    pages = " ".join(f"{p.get('text', '')[:400]} {p.get('description', '')}" for p in (digest.get("pages") or [])[:20])
    return f"{doc.get('name', '')} {digest.get('title', '')} {digest.get('summary', '')} {pages}".lower()
