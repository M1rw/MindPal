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
    "frontend/dist/voice-auth.bundle.js": 100_000,
    "frontend/voice/public/assets/voice-auth.bundle.js": 100_000,
    "frontend/voice/index.html": 200,
    "frontend/voice/assets/runtime.js": 10_000,
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

    capture_processors = list((ROOT / "frontend/voice/assets").glob("capture-processor-*.js"))
    if not capture_processors:
        fail("missing generated Voice AudioWorklet capture processor")

    print(
        "Frontend build verified: "
        f"{len(REQUIRED_OUTPUTS)} required outputs and "
        f"{len(capture_processors)} Voice worklet output(s)."
    )


if __name__ == "__main__":
    main()
