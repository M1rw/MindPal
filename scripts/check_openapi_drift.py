"""Fail if FastAPI /api routes drift from contracts/openapi.yaml."""

from __future__ import annotations

import json
import sys

from backend.http.drift import drift_report
from backend.main import create_app


def main() -> int:
    report = drift_report(create_app(serve_frontend=False))
    if report["ok"]:
        print("openapi drift: ok")
        return 0
    print(json.dumps(report, indent=2))
    return 1


if __name__ == "__main__":
    sys.exit(main())
