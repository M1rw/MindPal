#!/usr/bin/env python3
"""Deterministic frontend security, build, and integrity checks for MindPal."""

from __future__ import annotations

import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
INDEX = FRONTEND / "index.html"

FORBIDDEN_PATTERNS = {
    "permanent Gemini key endpoint": re.compile(r"/voice/key"),
    "permanent Gemini WebSocket key": re.compile(r"BidiGenerateContent\?key="),
    "deprecated Live API mediaChunks": re.compile(r"mediaChunks\s*:"),
    "dynamic code evaluation": re.compile(r"\b(?:eval|Function)\s*\("),
}

FORBIDDEN_RUNTIME_ORIGINS = (
    "cdn.tailwindcss.com",
    "unpkg.com",
    "www.gstatic.com/firebasejs",
)

REQUIRED_BUILD_OUTPUTS = {
    "frontend/css/tailwind.generated.css": 10_000,
    "frontend/dist/lucide.bundle.js": 5_000,
    "frontend/dist/app.bundle.js": 100_000,
}

DYNAMIC_ICON_NAMES = {"eye-off", "mic-off", "phone", "pin-off", "circle-minus", "check-circle-2"}


def fail(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def check_javascript_syntax() -> int:
    files = sorted([*FRONTEND.rglob("*.js"), *FRONTEND.rglob("*.mjs")])
    for path in files:
        result = subprocess.run(
            ["node", "--check", str(path)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode:
            fail(f"JavaScript syntax failed for {path.relative_to(ROOT)}\n{result.stderr}")
    return len(files)


def check_forbidden_patterns() -> None:
    candidates = [
        *FRONTEND.rglob("*.js"),
        *FRONTEND.rglob("*.mjs"),
        *FRONTEND.rglob("*.html"),
    ]
    for path in sorted(candidates):
        text = path.read_text(encoding="utf-8", errors="replace")
        for label, pattern in FORBIDDEN_PATTERNS.items():
            if pattern.search(text):
                fail(f"{label} found in {path.relative_to(ROOT)}")


def check_index_security() -> None:
    html = INDEX.read_text(encoding="utf-8")

    for origin in FORBIDDEN_RUNTIME_ORIGINS:
        if origin in html:
            fail(f"Production index executes a third-party runtime dependency: {origin}")

    script_tags = re.findall(r"<script\b[^>]*>[\s\S]*?</script>", html, flags=re.IGNORECASE)
    inline = [tag for tag in script_tags if not re.search(r"\bsrc\s*=", tag, flags=re.IGNORECASE)]
    if inline:
        fail(f"Production index contains {len(inline)} inline script block(s)")

    if "./dist/app.bundle.js" not in html or "./dist/lucide.bundle.js" not in html:
        fail("Production index does not reference the generated application and icon bundles")

    if "./css/tailwind.generated.css" not in html:
        fail("Production index does not reference the generated Tailwind stylesheet")


def check_html_ids_and_assets() -> tuple[int, int]:
    html = INDEX.read_text(encoding="utf-8")
    ids = re.findall(r'\bid=["\']([^"\']+)["\']', html)
    duplicates = [value for value, count in Counter(ids).items() if count > 1]
    if duplicates:
        fail(f"Duplicate HTML ids: {', '.join(sorted(duplicates))}")

    local_refs = re.findall(r'(?:src|href)=["\']([^"\']+)["\']', html)
    checked = 0
    for ref in local_refs:
        if ref.startswith(("http://", "https://", "data:", "#", "/_vercel/")):
            continue
        relative = ref.split("?", 1)[0].split("#", 1)[0]
        if not relative:
            continue
        target = FRONTEND / relative.lstrip("/") if relative.startswith("/") else FRONTEND / relative
        checked += 1
        if not target.exists():
            fail(f"Missing frontend asset referenced by index.html: {ref}")
    return len(ids), checked


def check_build_outputs() -> None:
    if not (ROOT / "package-lock.json").is_file():
        fail("package-lock.json is required for reproducible frontend builds")

    for relative, minimum_size in REQUIRED_BUILD_OUTPUTS.items():
        path = ROOT / relative
        if not path.is_file():
            fail(f"Missing generated build output: {relative}")
        if path.stat().st_size < minimum_size:
            fail(f"Generated build output is unexpectedly small: {relative}")

    runtime_config = (FRONTEND / "runtime-config.js").read_text(encoding="utf-8")
    if re.search(r"GEMINI_(?:API_)?KEY", runtime_config, flags=re.IGNORECASE):
        fail("runtime-config.js must never contain a Gemini provider secret")


def _to_kebab(name: str) -> str:
    return re.sub(r"([A-Za-z])([0-9])", r"\1-\2", re.sub(r"([a-z0-9])([A-Z])", r"\1-\2", name)).lower()


def check_icon_coverage() -> int:
    sources = [INDEX, *FRONTEND.glob("js/**/*.js")]
    requested: set[str] = set(DYNAMIC_ICON_NAMES)
    for path in sources:
        text = path.read_text(encoding="utf-8", errors="replace")
        requested.update(
            value
            for value in re.findall(r'data-lucide=["\']([^"\']+)["\']', text)
            if "${" not in value
        )

    vendor = (FRONTEND / "js/vendor/lucide_global.js").read_text(encoding="utf-8")
    definitions_match = re.search(r"const definitions = \{([\s\S]*?)\n\};", vendor)
    if not definitions_match:
        fail("Could not inspect the tree-shaken Lucide icon registry")

    available: set[str] = set()
    for raw_line in definitions_match.group(1).splitlines():
        line = raw_line.strip().rstrip(",")
        if not line:
            continue
        key = line.split(":", 1)[0].strip()
        available.add(key)
        available.add(_to_kebab(key))

    missing = sorted(requested - available)
    if missing:
        fail(f"Tree-shaken Lucide bundle is missing icons: {', '.join(missing)}")
    return len(requested)


def main() -> None:
    js_count = check_javascript_syntax()
    check_forbidden_patterns()
    check_index_security()
    id_count, asset_count = check_html_ids_and_assets()
    check_build_outputs()
    icon_count = check_icon_coverage()
    print(
        "Frontend audit passed: "
        f"{js_count} JS files, {id_count} DOM ids, {asset_count} assets, "
        f"{icon_count} icon names, production bundles and security invariants checked."
    )


if __name__ == "__main__":
    main()
