# backend/http/placeholders.py — 501/503 for preview operations not yet implemented

from __future__ import annotations

from fastapi import APIRouter, Request

from backend.core.contract import iter_operations
from backend.core.errors import AppError

router = APIRouter()


def _raise_unavailable(operation_id: str, path: str) -> None:
    raise AppError(
        "unavailable",
        "This operation is in the contract but not implemented yet.",
        details={"operation_id": operation_id, "path": path},
    )


def register_preview_placeholders(implemented: set[str]) -> APIRouter:
    """Register every OpenAPI operation that is not in `implemented` operationIds."""
    for op in iter_operations():
        operation_id = op["operation_id"]
        if operation_id in implemented:
            continue
        method = op["method"]
        path = op["path"]

        async def _placeholder(request: Request, *, _oid: str = operation_id, _path: str = path) -> None:
            _raise_unavailable(_oid, _path)

        router.add_api_route(
            path,
            _placeholder,
            methods=[method],
            operation_id=operation_id,
            name=operation_id,
        )
    return router
