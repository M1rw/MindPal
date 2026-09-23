"""Run the bilingual conversation evals.

    python scripts/eval/run_conversation_evals.py            # deterministic, no network
    python scripts/eval/run_conversation_evals.py --judge    # real replies + judge model (needs GEMINI_API_KEY)
    python scripts/eval/run_conversation_evals.py --judge --baseline data/evals/baseline.json

The judged run writes artifacts/evals/<timestamp>.json. With --baseline it
exits 1 if any rubric mean drops by more than --tolerance (default 0.3), so a
prompt or model change can be accepted or rejected on evidence.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--judge", action="store_true", help="generate real replies and score them (costs API calls)")
    parser.add_argument("--baseline", type=Path, help="previous judged report to compare against")
    parser.add_argument("--tolerance", type=float, default=0.3)
    args = parser.parse_args(argv)

    from backend.tools.evals import run_deterministic, run_judged

    if not args.judge:
        report = run_deterministic()
        print(f"{report['passed']}/{report['total']} cases passed")
        for category, score in report["by_category"].items():
            print(f"  {category:22s} {score}")
        for failure in report["failures"]:
            print(f"  FAIL {failure['id']}: {failure['failures']}")
        return 0 if report["passed"] == report["total"] else 1

    report = run_judged()
    out_dir = ROOT / "artifacts" / "evals"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Judged {report['cases']} cases -> {out}")
    for criterion, mean in report["means"].items():
        print(f"  {criterion:24s} {mean}")
    print(f"  {'overall':24s} {report['overall']}")

    if args.baseline:
        baseline = json.loads(args.baseline.read_text(encoding="utf-8"))["means"]
        regressions = {
            k: (baseline[k], v) for k, v in report["means"].items() if k in baseline and baseline[k] - v > args.tolerance
        }
        for criterion, (before, after) in regressions.items():
            print(f"  REGRESSION {criterion}: {before} -> {after}")
        return 1 if regressions else 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
