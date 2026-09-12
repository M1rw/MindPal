"""Check OpenAPI contract drift and architectural constraints for backend platform."""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Ensure root is in sys.path
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.http.drift import drift_report
from backend.main import create_app

MAX_HTTP_LOC = 150


def check_architectural_constraints() -> list[str]:
    errors = []
    http_dir = ROOT / "backend" / "http"
    if not http_dir.exists():
        return errors

    for py_file in http_dir.glob("*.py"):
        lines = py_file.read_text(encoding="utf-8").splitlines()
        loc = len([l for l in lines if l.strip() and not l.strip().startswith("#")])
        if loc > MAX_HTTP_LOC:
            errors.append(f"LOC Violation: {py_file.name} has {loc} non-comment lines (max allowed: {MAX_HTTP_LOC})")

        for line_num, line in enumerate(lines, 1):
            if "backend.infra" in line:
                errors.append(f"Import Boundary Violation: {py_file.name}:{line_num} imports directly from backend.infra")

    return errors


def main() -> int:
    report = drift_report(create_app(serve_frontend=False))
    arch_errors = check_architectural_constraints()

    if report["ok"] and not arch_errors:
        print("Backend Platform Verification: OK (Zero contract drift & clean import boundaries)")
        return 0

    if not report["ok"]:
        print("Contract Drift Report:")
        print(json.dumps(report, indent=2))

    if arch_errors:
        print("Architectural Violations:")
        for err in arch_errors:
            print(f"- {err}")

    return 1


if __name__ == "__main__":
    sys.exit(main())
