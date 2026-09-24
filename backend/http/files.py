# backend/http/files.py — Thin HTTP adapter for reading files and the library

from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Header, Query, Request
from starlette.concurrency import run_in_threadpool

from backend.core.errors import AppError
from backend.domain.files.contracts import (
    MAX_DIGEST_REQUEST_BYTES,
    DigestPagesRequest,
    LibraryCompleteRequest,
    LibraryPatchRequest,
    LibraryUploadRequest,
    LIMITS,
)
from backend.domain.files.digest import DigestService, assemble_pdf_digest
from backend.domain.files.library import LibraryService
from backend.domain.identity.identity import UserSession, account_guard, verify_auth_header
from backend.domain.quota.quota import peer_network_id
from backend.infra.blob import BlobUnavailable

router = APIRouter()
digests = DigestService()
library = LibraryService()


def _subject(session: UserSession, request: Request) -> str:
    return session.user_id_hash if session.has_account_storage else f"peer:{peer_network_id(request)}"


def _owner(session: UserSession) -> str:
    return session.user_id_hash if session.has_account_storage else ""


@router.post("/api/files/digest/image", operation_id="filesDigestImage")
async def digest_image(
    request: Request,
    authorization: Optional[str] = Header(None),
    content_type: str = Header("", alias="Content-Type"),
    file_hash: str = Header("", alias="X-File-Hash"),
    file_name: str = Header("", alias="X-File-Name"),
) -> Dict[str, Any]:
    """The downscaled image is the raw request body; the hash is the original file's."""
    session = await run_in_threadpool(verify_auth_header, authorization)
    if int(request.headers.get("content-length") or 0) > MAX_DIGEST_REQUEST_BYTES:
        raise AppError("payload_invalid", "That image is too large to read. Try a smaller one.")
    data = await request.body()
    digest = await run_in_threadpool(
        digests.digest_image,
        data,
        content_type,
        subject=_subject(session, request),
        signed_in=session.has_account_storage,
        owner=_owner(session),
        name=_header_name(file_name),
        file_hash=file_hash.strip().lower(),
    )
    return {"digest": digest.model_dump()}


@router.post("/api/files/digest/pages", operation_id="filesDigestPages")
async def digest_pages(
    payload: DigestPagesRequest,
    request: Request,
    authorization: Optional[str] = Header(None),
) -> Dict[str, Any]:
    """A batch of PDF pages: text layers are kept as they are, rendered pages are read."""
    session = await run_in_threadpool(verify_auth_header, authorization)
    return await run_in_threadpool(
        digests.digest_pages,
        payload,
        subject=_subject(session, request),
        signed_in=session.has_account_storage,
        owner=_owner(session),
    )


@router.post("/api/files/digest/assemble", operation_id="filesDigestAssemble")
async def digest_assemble(payload: Dict[str, Any], authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    """Page readings in, one PDF digest out (validated and capped the same way for everyone)."""
    await run_in_threadpool(verify_auth_header, authorization)
    try:
        digest = assemble_pdf_digest(
            str(payload.get("name") or "")[:200], int(payload.get("total_pages") or 1), list(payload.get("pages") or [])
        )
    except (TypeError, ValueError):
        raise AppError("payload_invalid", "Those pages could not be put together.")
    return {"digest": digest.model_dump()}


@router.get("/api/files/allowance", operation_id="filesAllowance")
async def allowance(request: Request, authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    session = await run_in_threadpool(verify_auth_header, authorization)
    signed_in = session.has_account_storage
    used = await run_in_threadpool(digests.allowance.usage, _subject(session, request), signed_in=signed_in)
    limits = LIMITS["account" if signed_in else "guest"]
    return {
        **used,
        "max_image_bytes": int(limits["max_image_bytes"]),
        "max_pdf_bytes": int(limits["max_pdf_bytes"]),
        "max_pdf_pages": int(limits["max_pdf_pages"]),
        "library_files": int(limits["library_files"]),
        "library_bytes": int(limits.get("library_bytes", 0)),
        "library_days": int(limits.get("library_days", 0)),
        "max_attachments": int(LIMITS["max_attachments_per_message"]),
        "signed_in": signed_in,
    }


# --- library (accounts only) ---------------------------------------------------

_guard = account_guard("keep files in your library")


@router.get("/api/library", operation_id="libraryList")
def library_list(q: str = Query("", max_length=120), session: UserSession = Depends(_guard)) -> Dict[str, Any]:
    return _blob_call(library.list, session.user_id_hash, q)


@router.post("/api/library/upload", operation_id="libraryStartUpload")
def library_start_upload(payload: LibraryUploadRequest, session: UserSession = Depends(_guard)) -> Dict[str, Any]:
    return _blob_call(library.start_upload, session.user_id_hash, payload)


@router.post("/api/library/{file_id}/complete", operation_id="libraryCompleteUpload")
def library_complete(file_id: str, payload: LibraryCompleteRequest, session: UserSession = Depends(_guard)) -> Dict[str, Any]:
    return _blob_call(library.complete, session.user_id_hash, file_id, payload.digest)


@router.get("/api/library/{file_id}", operation_id="libraryGet")
def library_get(file_id: str, session: UserSession = Depends(_guard)) -> Dict[str, Any]:
    return _blob_call(library.get, session.user_id_hash, file_id)


@router.patch("/api/library/{file_id}", operation_id="libraryRename")
def library_rename(file_id: str, payload: LibraryPatchRequest, session: UserSession = Depends(_guard)) -> Dict[str, Any]:
    return library.rename(session.user_id_hash, file_id, payload.name)


@router.delete("/api/library/{file_id}", operation_id="libraryDelete")
def library_delete(file_id: str, session: UserSession = Depends(_guard)) -> Dict[str, Any]:
    return {"deleted": _blob_call(library.delete, session.user_id_hash, file_id)}


def _blob_call(fn: Any, *args: Any) -> Any:
    try:
        return fn(*args)
    except BlobUnavailable:
        raise AppError("unavailable", "File storage is briefly unavailable. Please try again.")


def _header_name(raw: str) -> str:
    """File names travel percent-encoded in a header (headers are Latin-1)."""
    from urllib.parse import unquote

    return unquote(raw or "")[:200]
