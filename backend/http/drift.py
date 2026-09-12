# backend/http/drift.py

from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from fastapi.routing import APIRoute

from backend.core.contract import iter_operations

SKIP_PATH_PREFIXES = ("/css", "/js", "/dist", "/assets")
SKIP_PATHS = {"/", "/runtime-config.js", "/openapi.json", "/docs", "/redoc"}


def contract_ops() -> set[tuple[str, str, str]]:
    return {(op["method"], op["path"], op["operation_id"]) for op in iter_operations()}


def fastapi_api_ops(app: FastAPI) -> set[tuple[str, str, str]]:
    found: set[tuple[str, str, str]] = set()
    for route in app.routes:
        if not isinstance(route, APIRoute):
            continue
        path = route.path
        if path in SKIP_PATHS or path.startswith(SKIP_PATH_PREFIXES):
            continue
        if not path.startswith("/api"):
            continue
        methods = {m.upper() for m in (route.methods or set()) if m.upper() in {"GET", "POST", "PUT", "PATCH", "DELETE"}}
        operation_id = route.operation_id or route.unique_id
        for method in methods:
            found.add((method, path, str(operation_id)))
    return found


def drift_report(app: FastAPI) -> dict[str, Any]:
    spec = contract_ops()
    live = fastapi_api_ops(app)
    extra = sorted(live - spec)
    missing = sorted(spec - live)
    return {
        "ok": not extra and not missing,
        "extra": extra,
        "missing": missing,
    }
