#!/usr/bin/env python3
"""Fail the Vercel build if committed frontend artifacts are missing or stale.

This script intentionally uses only the Python standard library. Vercel does not
need npm, Tailwind, or esbuild to deploy MindPal; those tools run during local/CI
release creation and their immutable outputs are committed to the repository.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "frontend" / "prebuilt-assets.manifest.json"
MINIMUM_BYTES = {
    "frontend/css/tailwind.generated.css": 10_000,
    "frontend/dist/lucide.bundle.js": 5_000,
    "frontend/dist/app.bundle.js": 100_000,
}


def fail(message: str) -> None:
    raise SystemExit(f"Prebuilt frontend verification failed: {message}")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load_manifest() -> dict[str, Any]:
    if not MANIFEST.is_file():
        fail(f"missing {MANIFEST.relative_to(ROOT)}")
    try:
        payload = json.loads(MANIFEST.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"invalid manifest: {exc}")
    if payload.get("schema_version") != 1:
        fail("unsupported manifest schema")
    return payload


def aggregate_digest(files: list[str]) -> str:
    digest = hashlib.sha256()
    for name in files:
        relative = Path(name)
        path = ROOT / relative
        if not path.is_file():
            fail(f"missing build input {name}")
        digest.update(relative.as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes().replace(b"\r\n", b"\n"))
        digest.update(b"\0")
    return digest.hexdigest()


def main() -> None:
    manifest = load_manifest()
    source_files = manifest.get("source_files")
    if not isinstance(source_files, list) or not all(isinstance(item, str) for item in source_files):
        fail("source_files must be a list of paths")

    actual_source_digest = aggregate_digest(source_files)
    expected_source_digest = manifest.get("source_digest")
    if actual_source_digest != expected_source_digest:
        fail(
            "frontend source changed without rebuilding artifacts; run `npm ci && npm run build` "
            "and commit the generated files"
        )

    outputs = manifest.get("outputs")
    if not isinstance(outputs, dict):
        fail("outputs map is missing")

    for name, minimum in MINIMUM_BYTES.items():
        expected = outputs.get(name)
        if not isinstance(expected, dict):
            fail(f"manifest entry missing for {name}")
        path = ROOT / name
        if not path.is_file():
            fail(f"missing output {name}")
        data = path.read_bytes().replace(b"\r\n", b"\n")
        if len(data) < minimum:
            fail(f"output {name} is unexpectedly small ({len(data)} bytes)")
        if expected.get("bytes") != len(data):
            fail(f"size mismatch for {name}")
        if expected.get("sha256") != sha256_bytes(data):
            fail(f"SHA-256 mismatch for {name}")

    print(
        "Prebuilt frontend verified: "
        f"{len(source_files)} inputs, {len(MINIMUM_BYTES)} immutable outputs."
    )


if __name__ == "__main__":
    main()
