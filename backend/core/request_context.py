from __future__ import annotations

from contextvars import ContextVar

_REQUEST_ID: ContextVar[str] = ContextVar("mindpal_request_id", default="")


def set_request_id(value: str) -> None:
    _REQUEST_ID.set(value)


def request_id() -> str:
    return _REQUEST_ID.get()
