#!/usr/bin/env python3
"""Generate the immutable manifest for MindPal's prebuilt frontend artifacts."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "frontend" / "prebuilt-assets.manifest.json"
OUTPUTS = (
    Path("frontend/css/tailwind.generated.css"),
    Path("frontend/dist/lucide.bundle.js"),
    Path("frontend/dist/app.bundle.js"),
)
STATIC_INPUTS = (
    Path("package.json"),
    Path("package-lock.json"),
    Path("tailwind.config.cjs"),
    Path("frontend/index.html"),
    Path("frontend/css/tailwind.input.css"),
)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def source_files() -> list[Path]:
    files = set(STATIC_INPUTS)
    files.update(path.relative_to(ROOT) for path in (ROOT / "frontend" / "js").rglob("*.js"))
    files.update(path.relative_to(ROOT) for path in (ROOT / "frontend" / "js").rglob("*.mjs"))
    return sorted(files, key=lambda path: path.as_posix())


def metadata(relative: Path) -> dict[str, object]:
    path = ROOT / relative
    if not path.is_file():
        raise SystemExit(f"Missing required frontend file: {relative.as_posix()}")
    data = path.read_bytes()
    return {"bytes": len(data), "sha256": sha256_bytes(data)}


def aggregate_digest(files: list[Path]) -> str:
    digest = hashlib.sha256()
    for relative in files:
        path = ROOT / relative
        if not path.is_file():
            raise SystemExit(f"Missing frontend build input: {relative.as_posix()}")
        digest.update(relative.as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def main() -> None:
    inputs = source_files()
    payload = {
        "schema_version": 1,
        "source_digest": aggregate_digest(inputs),
        "source_files": [path.as_posix() for path in inputs],
        "outputs": {path.as_posix(): metadata(path) for path in OUTPUTS},
    }
    MANIFEST.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {MANIFEST.relative_to(ROOT)} with {len(inputs)} tracked inputs.")


if __name__ == "__main__":
    main()
