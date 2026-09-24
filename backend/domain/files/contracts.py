"""Shapes for files, digests and the library, plus the configured limits."""

from __future__ import annotations

import re
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, field_validator

from backend.configs.runtime import api_limits_config

LIMITS: Dict[str, Any] = api_limits_config()["files"]
MAX_PAGE_TEXT = int(LIMITS["max_page_text_chars"])
MAX_DIGEST_TEXT = int(LIMITS["max_digest_text_chars"])
MAX_DIGEST_REQUEST_BYTES = int(LIMITS["max_digest_request_bytes"])
MAX_IMAGES_PER_CALL = int(LIMITS["max_images_per_vision_call"])
MAX_ATTACHMENTS = int(LIMITS["max_attachments_per_message"])
# A picture sent along with its turn (downscaled in the browser): ~1 MB of base64.
MAX_TURN_IMAGE_B64 = 1_400_000
DIGEST_VERSION = 1

IMAGE_TYPES = ("image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif")
PDF_TYPE = "application/pdf"

PageKind = Literal["text", "visual", "mixed", "empty"]
FileKind = Literal["image", "pdf"]

_HASH = re.compile(r"^[a-f0-9]{16,64}$")
_FILE_ID = re.compile(r"^f_[a-z0-9]{8,40}$")


def tier(signed_in: bool) -> Dict[str, Any]:
    return LIMITS["account" if signed_in else "guest"]


def valid_hash(value: str) -> str:
    clean = (value or "").strip().lower()
    if not _HASH.match(clean):
        raise ValueError("invalid content hash")
    return clean


def valid_file_id(value: str) -> str:
    clean = (value or "").strip()
    if not _FILE_ID.match(clean):
        raise ValueError("invalid file id")
    return clean


def clip_text(text: Any, limit: int = MAX_PAGE_TEXT) -> str:
    clean = str(text or "").replace("\x00", "").strip()
    return clean[:limit]


class PageDigest(BaseModel):
    n: int = Field(ge=1, le=2000)
    kind: PageKind = "text"
    text: str = ""
    description: str = ""

    @field_validator("text")
    @classmethod
    def _cap_text(cls, value: str) -> str:
        return clip_text(value)

    @field_validator("description")
    @classmethod
    def _cap_description(cls, value: str) -> str:
        return clip_text(value, 1200)


class Digest(BaseModel):
    version: int = DIGEST_VERSION
    kind: FileKind
    content: PageKind = "text"
    name: str = Field(default="", max_length=200)
    title: str = Field(default="", max_length=160)
    summary: str = Field(default="", max_length=600)
    language: str = Field(default="", max_length=16)
    total_pages: int = Field(default=1, ge=1, le=2000)
    pages: List[PageDigest] = Field(default_factory=list)

    @field_validator("pages")
    @classmethod
    def _cap_total(cls, pages: List[PageDigest]) -> List[PageDigest]:
        total = 0
        kept: List[PageDigest] = []
        for page in sorted(pages, key=lambda p: p.n):
            total += len(page.text) + len(page.description)
            if total > MAX_DIGEST_TEXT:
                break
            kept.append(page)
        return kept

    def text_chars(self) -> int:
        return sum(len(p.text) + len(p.description) for p in self.pages)


class DigestPageIn(BaseModel):
    """A page as the browser sends it: its text layer, or a rendered image for the vision pipeline."""

    n: int = Field(ge=1, le=2000)
    text: str = Field(default="", max_length=60000)
    image: str = Field(default="", max_length=3_000_000)  # base64
    mime: str = Field(default="image/jpeg", max_length=40)


class DigestPagesRequest(BaseModel):
    hash: str
    name: str = Field(default="", max_length=200)
    total_pages: int = Field(ge=1, le=2000)
    pages: List[DigestPageIn] = Field(min_length=1, max_length=40)

    @field_validator("hash")
    @classmethod
    def _hash(cls, value: str) -> str:
        return valid_hash(value)


class LibraryUploadRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    mime: str = Field(min_length=3, max_length=80)
    size: int = Field(ge=1)
    hash: str
    pages: int = Field(default=1, ge=1, le=2000)
    previews: int = Field(default=0, ge=0, le=6)

    @field_validator("hash")
    @classmethod
    def _hash(cls, value: str) -> str:
        return valid_hash(value)


class LibraryCompleteRequest(BaseModel):
    digest: Digest


class LibraryPatchRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class AttachmentRef(BaseModel):
    """What a chat message carries for one file.

    An account's library file by id, or the digest itself (guests, whose files
    stay on their device). On the turn a picture is first sent, `image` also
    carries it (downscaled, base64) so the reply can look at it directly.
    """

    file_id: Optional[str] = None
    digest: Optional[Digest] = None
    name: str = Field(default="", max_length=200)
    image: str = Field(default="", max_length=MAX_TURN_IMAGE_B64)
    mime: str = Field(default="image/jpeg", max_length=40)

    @field_validator("file_id")
    @classmethod
    def _file_id(cls, value: Optional[str]) -> Optional[str]:
        return valid_file_id(value) if value else None
