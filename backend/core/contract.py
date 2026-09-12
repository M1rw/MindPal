# backend/core/contract.py — load OpenAPI + error catalog from contracts/

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any, Iterator

import yaml

ROOT = Path(__file__).resolve().parents[2]
CONTRACTS = ROOT / "contracts"
HTTP_METHODS = frozenset({"get", "post", "put", "patch", "delete"})
REQUIRED_XM = ("owner", "status", "audience", "ai-access", "client", "sunset", "side-effects")


@lru_cache(maxsize=1)
def openapi_document() -> dict[str, Any]:
    path = CONTRACTS / "openapi.yaml"
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or "paths" not in data:
        raise RuntimeError("contracts/openapi.yaml is missing paths")
    return data


@lru_cache(maxsize=1)
def error_catalog() -> dict[str, dict[str, Any]]:
    raw = yaml.safe_load((CONTRACTS / "errors.yaml").read_text(encoding="utf-8"))
    codes = raw.get("codes") if isinstance(raw, dict) else None
    if not isinstance(codes, dict):
        raise RuntimeError("contracts/errors.yaml is missing codes")
    return codes


def iter_operations() -> Iterator[dict[str, Any]]:
    paths = openapi_document().get("paths") or {}
    for path, item in paths.items():
        if not isinstance(item, dict):
            continue
        for method, op in item.items():
            if method.lower() not in HTTP_METHODS or not isinstance(op, dict):
                continue
            xm = op.get("x-mindpal")
            if not isinstance(xm, dict):
                raise RuntimeError(f"{method.upper()} {path} missing x-mindpal")
            missing = [key for key in REQUIRED_XM if key not in xm]
            if missing:
                raise RuntimeError(f"{method.upper()} {path} missing x-mindpal.{missing}")
            operation_id = op.get("operationId")
            if not operation_id:
                raise RuntimeError(f"{method.upper()} {path} missing operationId")
            yield {
                "method": method.upper(),
                "path": path,
                "operation_id": str(operation_id),
                "x_mindpal": xm,
            }


def live_operations() -> list[dict[str, Any]]:
    return [op for op in iter_operations() if op["x_mindpal"].get("status") == "live"]
