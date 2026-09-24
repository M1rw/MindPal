"""Run the bilingual conversation evals.

    python scripts/eval/run_conversation_evals.py            # deterministic, no network
    python scripts/eval/run_conversation_evals.py --judge    # real replies + judge model (needs GEMINI_API_KEY)
    python scripts/eval/run_conversation_evals.py --judge --baseline data/evals/baseline.json
    python scripts/eval/run_conversation_evals.py --judge --only en-short,ar-   # case id prefixes
    python scripts/eval/run_conversation_evals.py --judge --style concise --no-emoji

Judged runs use the app's default personalization (what most people send)
unless --style/--warmth/--no-emoji/--no-lists say otherwise. Each reply also
gets a deterministic shape score (backend/tools/reply_quality.py).

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
    parser.add_argument("--rejudge", type=Path, help="judge again the failed rows of a saved report, keeping its replies")
    parser.add_argument("--only", default="", help="comma-separated case id prefixes")
    parser.add_argument("--no-judge-model", action="store_true", help="shape scores only; skip the judge calls")
    parser.add_argument("--judge-provider", default="gemini", choices=("gemini", "openrouter", "groq"))
    parser.add_argument("--style", choices=("concise", "balanced", "detailed"))
    parser.add_argument("--warmth", choices=("warm", "neutral", "direct"))
    parser.add_argument("--no-emoji", action="store_true")
    parser.add_argument("--no-lists", action="store_true")
    args = parser.parse_args(argv)

    from backend.tools.evals import APP_DEFAULT_PERSONALIZATION, load_cases, run_deterministic, run_judged

    cases = load_cases()
    if args.only:
        prefixes = tuple(p.strip() for p in args.only.split(",") if p.strip())
        cases = [c for c in cases if c["id"].startswith(prefixes)]

    if not args.judge:
        report = run_deterministic(cases)
        print(f"{report['passed']}/{report['total']} cases passed")
        for category, score in report["by_category"].items():
            print(f"  {category:22s} {score}")
        for failure in report["failures"]:
            print(f"  FAIL {failure['id']}: {failure['failures']}")
        return 0 if report["passed"] == report["total"] else 1

    persona = dict(APP_DEFAULT_PERSONALIZATION)
    if args.style:
        persona["baseStyle"] = args.style
    if args.warmth:
        persona["warmth"] = args.warmth
    if args.no_emoji:
        persona["emojiSupport"] = False
    if args.no_lists:
        persona["useHeadersLists"] = False
    if args.rejudge:
        from backend.tools.evals import rejudge

        report = rejudge(json.loads(args.rejudge.read_text(encoding="utf-8")), provider=args.judge_provider)
        args.rejudge.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"Re-judged -> {args.rejudge} ({report['judged']}/{report['cases']} judged)")
        for criterion, mean in report["means"].items():
            print(f"  {criterion:24s} {mean}")
        print(f"  {'overall':24s} {report['overall']}")
        print(f"  {'shape (0-100)':24s} {report['shape']['mean']}   median words {report['shape']['median_words']}")
        print(f"  flags: {report['shape']['flags']}")
        return 0
    report = run_judged(cases, personalization=persona, judge=not args.no_judge_model, judge_provider=args.judge_provider)
    out_dir = ROOT / "artifacts" / "evals"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Judged {report['cases']} cases -> {out}")
    for criterion, mean in report["means"].items():
        print(f"  {criterion:24s} {mean}")
    print(f"  {'overall':24s} {report['overall']}")
    shape = report["shape"]
    print(f"  {'shape (0-100)':24s} {shape['mean']}   median words {shape['median_words']}   median latency {shape.get('median_latency_s')}s")
    for category, score in shape["by_category"].items():
        print(f"    {category:22s} {score}")
    print(f"  flags: {shape['flags']}")
    if report["failed"]:
        print(f"  no reply (provider errors): {report['failed']}")

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
