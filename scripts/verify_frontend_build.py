"""Verify frontend and Voice artifacts generated in the current build workspace.

Vercel runs the build command before serving the FastAPI application. This
check validates the outputs produced by that build; it deliberately does not
read a Git-tracked manifest or require generated distributions to exist in the
repository checkout.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REQUIRED_OUTPUTS = {
    "frontend/css/tailwind.generated.css": 10_000,
    "frontend/dist/lucide.bundle.js": 5_000,
    "frontend/dist/app.bundle.js": 100_000,
    "frontend/dist/brain.bundle.js": 1_000,
}


def fail(message: str) -> None:
    raise SystemExit(f"Frontend build verification failed: {message}")


def main() -> None:
    for name, minimum_bytes in REQUIRED_OUTPUTS.items():
        path = ROOT / name
        if not path.is_file():
            fail(f"missing Vercel-generated output {name}")
        size = path.stat().st_size
        if size < minimum_bytes:
            fail(f"generated output {name} is unexpectedly small ({size} bytes)")

    print(
        "Frontend build verified: "
        f"{len(REQUIRED_OUTPUTS)} required non-Voice outputs."
    )


if __name__ == "__main__":
    main()
