"""Pass or fail a nightly smoke eval report (scripts/eval/run_conversation_evals.py).

Fails when a reply errored or came back empty, or when the deterministic
shape score (length and form fit, backend/tools/reply_quality.py) drops below
the floor. Writes a short summary for the GitHub job page.

    python scripts/eval/check_smoke.py artifacts/evals/<report>.json --min-shape 85
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("report", type=Path)
    parser.add_argument("--min-shape", type=float, default=85.0)
    args = parser.parse_args()

    report = json.loads(args.report.read_text(encoding="utf-8"))
    rows = report.get("rows") or []
    empty = [row["id"] for row in rows if not str(row.get("reply") or "").strip()]
    failed_rows = report.get("failed") or []
    failed = len(failed_rows) if isinstance(failed_rows, list) else int(failed_rows)
    shape_block = report.get("shape") or {}
    shape = float(shape_block.get("mean", 0.0)) if isinstance(shape_block, dict) else float(shape_block)
    latencies = [float(row["latency_s"]) for row in rows if row.get("latency_s") is not None]
    median = statistics.median(latencies) if latencies else 0.0

    problems = []
    if not rows:
        problems.append("no replies were generated")
    if failed:
        problems.append(f"{failed} case(s) errored")
    if empty:
        problems.append(f"empty replies: {', '.join(empty)}")
    if rows and shape < args.min_shape:
        problems.append(f"shape score {shape:.0f} is under {args.min_shape:.0f}")

    lines = [
        "## Nightly reply smoke check",
        f"- cases: {len(rows)}, failed: {failed}, shape: {shape:.0f}",
        f"- median reply time: {median:.1f}s",
        f"- result: {'FAIL: ' + '; '.join(problems) if problems else 'pass'}",
    ]
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")
    print("\n".join(lines))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
