"""File bytes for the library: originals, thumbnails, rendered pages.

The document store holds JSON; files do not belong in it (whole-row rewrites,
and a request body cap of 4.5 MB on the platform). Bytes live in object
storage instead, and never pass through the API: the browser uploads to and
downloads from short-lived signed URLs, and the server only signs, checks
sizes, and deletes.

Production: a private Supabase Storage bucket, reached with the service key
the document store already uses. Tests and local runs: an in-memory store with
the same behaviour.
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Dict, List, Optional, Protocol
from urllib.parse import quote

import httpx

from backend.configs.settings import get_settings

logger = logging.getLogger("mindpal.blob")

BUCKET = "mindpal-library"
SIGNED_UPLOAD_SECONDS = 600
SIGNED_DOWNLOAD_SECONDS = 3600


class BlobUnavailable(RuntimeError):
    """Object storage could not be reached or refused the request."""


@dataclass(frozen=True)
class BlobObject:
    path: str
    size: int
    content_type: str


class BlobStore(Protocol):
    provider_name: str

    def signed_upload_url(self, path: str, content_type: str) -> str: ...
    def signed_download_url(self, path: str, seconds: int = SIGNED_DOWNLOAD_SECONDS) -> str: ...
    def stat(self, path: str) -> Optional[BlobObject]: ...
    def list_prefix(self, prefix: str) -> List[BlobObject]: ...
    def delete_paths(self, paths: List[str]) -> int: ...


def _clean_path(path: str) -> str:
    clean = path.strip().lstrip("/")
    if not clean or ".." in clean.split("/"):
        raise ValueError("invalid blob path")
    return clean


class MemoryBlobStore:
    """Signed URLs are fake but exercisable: `put` stands in for the browser upload."""

    provider_name = "memory"

    def __init__(self) -> None:
        self._objects: Dict[str, tuple[bytes, str]] = {}
        self._tokens: Dict[str, tuple[str, str, float]] = {}
        self._lock = threading.Lock()

    def signed_upload_url(self, path: str, content_type: str) -> str:
        token = uuid.uuid4().hex
        with self._lock:
            self._tokens[token] = (_clean_path(path), content_type, time.time() + SIGNED_UPLOAD_SECONDS)
        return f"memory://upload/{token}"

    def put(self, upload_url: str, data: bytes) -> None:
        token = upload_url.rsplit("/", 1)[-1]
        with self._lock:
            path, content_type, expires = self._tokens.pop(token)
            if time.time() > expires:
                raise BlobUnavailable("upload link expired")
            self._objects[path] = (data, content_type)

    def signed_download_url(self, path: str, seconds: int = SIGNED_DOWNLOAD_SECONDS) -> str:
        return f"memory://download/{quote(_clean_path(path))}?expires={int(time.time()) + seconds}"

    def read(self, path: str) -> Optional[bytes]:
        item = self._objects.get(_clean_path(path))
        return item[0] if item else None

    def stat(self, path: str) -> Optional[BlobObject]:
        clean = _clean_path(path)
        item = self._objects.get(clean)
        return BlobObject(clean, len(item[0]), item[1]) if item else None

    def list_prefix(self, prefix: str) -> List[BlobObject]:
        clean = _clean_path(prefix)
        with self._lock:
            return [BlobObject(p, len(d), t) for p, (d, t) in self._objects.items() if p.startswith(clean)]

    def delete_paths(self, paths: List[str]) -> int:
        removed = 0
        with self._lock:
            for path in paths:
                if self._objects.pop(_clean_path(path), None) is not None:
                    removed += 1
        return removed


class SupabaseBlobStore:
    """Supabase Storage REST (storage/v1) with the service role key."""

    provider_name = "supabase"

    def __init__(self, url: str, service_key: str, *, bucket: str = BUCKET, client: httpx.Client | None = None) -> None:
        self._url = url.rstrip("/")
        self._bucket = bucket
        self._client = client or httpx.Client(
            base_url=f"{self._url}/storage/v1",
            timeout=15.0,
            headers={"apikey": service_key, "Authorization": f"Bearer {service_key}"},
        )

    def _call(self, method: str, path: str, **kwargs) -> httpx.Response:
        try:
            response = self._client.request(method, path, **kwargs)
        except httpx.HTTPError as exc:
            raise BlobUnavailable(f"storage {method} failed: {type(exc).__name__}") from exc
        if response.status_code >= 500:
            raise BlobUnavailable(f"storage {method} {response.status_code}")
        return response

    def ensure_bucket(self, *, file_size_limit: int) -> bool:
        """Create the private bucket if missing. True when it was created."""
        response = self._call(
            "POST",
            "/bucket",
            json={"id": self._bucket, "name": self._bucket, "public": False, "file_size_limit": file_size_limit},
        )
        if response.status_code in (200, 201):
            return True
        if response.status_code in (400, 409) and "exist" in response.text.lower():
            return False
        raise BlobUnavailable(f"bucket create {response.status_code}: {response.text[:200]}")

    def signed_upload_url(self, path: str, content_type: str) -> str:
        clean = _clean_path(path)
        response = self._call("POST", f"/object/upload/sign/{self._bucket}/{quote(clean)}", headers={"x-upsert": "true"})
        if response.status_code != 200:
            raise BlobUnavailable(f"sign upload {response.status_code}")
        relative = response.json().get("url") or ""
        return f"{self._url}/storage/v1{relative}"

    def signed_download_url(self, path: str, seconds: int = SIGNED_DOWNLOAD_SECONDS) -> str:
        clean = _clean_path(path)
        response = self._call("POST", f"/object/sign/{self._bucket}/{quote(clean)}", json={"expiresIn": seconds})
        if response.status_code != 200:
            raise BlobUnavailable(f"sign download {response.status_code}")
        relative = response.json().get("signedURL") or response.json().get("signedUrl") or ""
        return f"{self._url}/storage/v1{relative}"

    def _list(self, folder: str) -> List[dict]:
        response = self._call(
            "POST", f"/object/list/{self._bucket}", json={"prefix": folder, "limit": 1000, "offset": 0}
        )
        if response.status_code != 200:
            raise BlobUnavailable(f"list {response.status_code}")
        return list(response.json() or [])

    def stat(self, path: str) -> Optional[BlobObject]:
        clean = _clean_path(path)
        folder, _, name = clean.rpartition("/")
        for item in self._list(folder):
            if item.get("name") == name and item.get("id"):
                meta = item.get("metadata") or {}
                return BlobObject(clean, int(meta.get("size") or 0), str(meta.get("mimetype") or ""))
        return None

    def list_prefix(self, prefix: str) -> List[BlobObject]:
        """Every object under a folder, recursively (folders come back without an id)."""
        out: List[BlobObject] = []
        pending = [_clean_path(prefix).rstrip("/")]
        while pending:
            folder = pending.pop()
            for item in self._list(folder):
                name = item.get("name") or ""
                full = f"{folder}/{name}" if folder else name
                if item.get("id"):
                    meta = item.get("metadata") or {}
                    out.append(BlobObject(full, int(meta.get("size") or 0), str(meta.get("mimetype") or "")))
                elif name:
                    pending.append(full)
        return out

    def delete_paths(self, paths: List[str]) -> int:
        if not paths:
            return 0
        removed = 0
        for start in range(0, len(paths), 500):
            chunk = [_clean_path(p) for p in paths[start : start + 500]]
            response = self._call("DELETE", f"/object/{self._bucket}", json={"prefixes": chunk})
            if response.status_code != 200:
                raise BlobUnavailable(f"delete {response.status_code}")
            removed += len(response.json() or [])
        return removed


_STORE: Optional[BlobStore] = None
_STORE_LOCK = threading.Lock()


def get_blob_store() -> BlobStore:
    """Supabase Storage when the document store is Supabase; memory otherwise."""
    global _STORE
    with _STORE_LOCK:
        if _STORE is None:
            settings = get_settings()
            url, key = settings.supabase_settings()
            if settings.configured_storage_provider() == "supabase" and url and key:
                _STORE = SupabaseBlobStore(url, key)
            else:
                logger.warning("blob_store provider=memory (files are not durable)")
                _STORE = MemoryBlobStore()
        return _STORE


def reset_blob_store(store: Optional[BlobStore] = None) -> None:
    global _STORE
    with _STORE_LOCK:
        _STORE = store
