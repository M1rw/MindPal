"""Which chat model understands Egyptian Arabic best? Same cases, same prompt, same judge.

    python scripts/eval/model_bakeoff.py --drive                  # every candidate, one process each
    python scripts/eval/model_bakeoff.py --candidate gemini-3.5-flash
    python scripts/eval/model_bakeoff.py --report                 # summarize saved runs

Cases: data/evals/egyptian.json (24). Each candidate runs through the real chat
pipeline pinned to that single model (no fallback, so one reply never comes from
a spare), then every reply is judged by the same model on the standard
rubric with each case's `intent` as ground truth. A process per candidate,
because provider clients are bound to the event loop that made them.
Reports: artifacts/evals/bakeoff/<candidate>.json, summary: summary.md.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
OUT = ROOT / "artifacts" / "evals" / "bakeoff"

JUDGE_PROVIDER = "groq"
JUDGE_MODEL = "openai/gpt-oss-120b"  # its own per-model quota; it also judges its own replies, so read that row with that in mind

# name -> env that selects the model. Runs without "+note" were made before the Egyptian
# dialect note existed (equivalent to MINDPAL_DIALECT_NOTE=0); "+note" runs have it on.
CANDIDATES: Dict[str, Dict[str, str]] = {
    "groq-qwen3.8-27b (current)": {"MINDPAL_CHAT_PROVIDER": "groq", "GROQ_MODEL": "qwen/qwen3.8-27b"},
    "groq-qwen3.8-27b+note": {"MINDPAL_CHAT_PROVIDER": "groq", "GROQ_MODEL": "qwen/qwen3.8-27b"},
    "groq-gpt-oss-120b": {"MINDPAL_CHAT_PROVIDER": "groq", "GROQ_MODEL": "openai/gpt-oss-120b"},
    "groq-allam-2-7b": {"MINDPAL_CHAT_PROVIDER": "groq", "GROQ_MODEL": "allam-2-7b"},
    "groq-gpt-oss-120b+note": {"MINDPAL_CHAT_PROVIDER": "groq", "GROQ_MODEL": "openai/gpt-oss-120b"},
    "gemini-2.5-flash": {"MINDPAL_CHAT_PROVIDER": "gemini", "GEMINI_MODEL": "gemini-2.5-flash"},
    "gemini-3.1-flash-lite": {"MINDPAL_CHAT_PROVIDER": "gemini", "GEMINI_MODEL": "gemini-3.1-flash-lite"},
    "gemini-3.5-flash": {"MINDPAL_CHAT_PROVIDER": "gemini", "GEMINI_MODEL": "gemini-3.5-flash"},
    "gemini-3.8-flash": {"MINDPAL_CHAT_PROVIDER": "gemini", "GEMINI_MODEL": "gemini-3.8-flash"},
}


def _slug(name: str) -> str:
    return name.split(" ")[0]


def run_candidate(name: str, pause: float) -> None:
    os.environ.update(CANDIDATES[name])
    os.environ["GROQ_JSON_MODEL"] = JUDGE_MODEL
    from backend.infra.llm import gateway as gateway_module
    from backend.tools.evals import load_cases, rejudge, run_judged

    # No spares for the chat model or the judge: a rate-limited reply is retried on the model
    # under test, and a failed judgment is retried on the judge, never handed to another model.
    gateway_module.fallback_ladder = lambda: []  # type: ignore[assignment]
    cases = load_cases(ROOT / "data" / "evals" / "egyptian.json")
    report = run_judged(cases, judge=True, judge_provider=JUDGE_PROVIDER, pause_seconds=pause)
    for _ in range(3):
        if not any(r.get("reply") and row_overall(r) is None for r in report["rows"]):
            break
        report = rejudge(report, provider=JUDGE_PROVIDER, pace_seconds=3.0)
    kinds = {c["id"]: c["kind"] for c in cases}
    for row in report["rows"]:
        row["kind"] = kinds[row["id"]]
    report["candidate"] = name
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{_slug(name)}.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[{name}] overall {report['overall']} failed {report['failed']}", flush=True)


def _complete(name: str) -> bool:
    path = OUT / f"{_slug(name)}.json"
    if not path.exists():
        return False
    rows = json.loads(path.read_text(encoding="utf-8"))["rows"]
    return all(r.get("reply") and row_overall(r) is not None for r in rows)


def row_overall(row: Dict[str, Any]) -> float | None:
    from backend.tools.evals import CRITERIA

    vals = [float(row["scores"][c]) for c in CRITERIA if isinstance(row["scores"].get(c), (int, float))]
    return round(statistics.mean(vals), 3) if vals else None


def report() -> str:
    from backend.domain.chat.dialect import check_dialect
    from backend.tools.evals import CRITERIA

    reports = {}
    for name in CANDIDATES:
        path = OUT / f"{_slug(name)}.json"
        if path.exists():
            reports[name] = json.loads(path.read_text(encoding="utf-8"))
    kinds = ["trap", "venting", "own", "light", "advice"]
    lines = ["# Egyptian Arabic: model bake-off\n", f"Judge: {JUDGE_PROVIDER}/{JUDGE_MODEL}. Same prompt, same cases (24), one sample each. Scores 1-5.\n"]
    lines.append("| model | judged | overall | specificity | naturalness | insight | length_fit | focus | language_match | leaky replies | " + " | ".join(kinds) + " |")
    lines.append("|" + "---|" * (10 + len(kinds)))
    for name, r in sorted(reports.items(), key=lambda kv: -(statistics.mean([row_overall(x) for x in kv[1]["rows"] if row_overall(x) is not None] or [0]))):
        rows = [x for x in r["rows"] if row_overall(x) is not None]
        if not rows:
            continue
        crit = {c: statistics.mean(float(x["scores"][c]) for x in rows if isinstance(x["scores"].get(c), (int, float))) for c in CRITERIA}
        by_kind = []
        for k in kinds:
            v = [row_overall(x) for x in rows if x["kind"] == k]
            by_kind.append(f"{statistics.mean(v):.2f}" if v else "-")
        overall = statistics.mean(row_overall(x) for x in rows)
        leaky = sum(1 for x in rows if x.get("reply") and not check_dialect(x["reply"]).clean)
        lines.append(
            f"| {name} | {len(rows)}/{r['cases']} | **{overall:.2f}** | {crit['specificity']:.2f} | {crit['naturalness']:.2f} | {crit['insight']:.2f} | "
            f"{crit['length_fit']:.2f} | {crit['focus']:.2f} | {crit['language_match']:.2f} | {leaky}/{len(rows)} | " + " | ".join(by_kind) + " |"
        )
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--candidate")
    parser.add_argument("--drive", action="store_true")
    parser.add_argument("--report", action="store_true")
    parser.add_argument("--pause", type=float, default=2.0)
    args = parser.parse_args()
    if args.candidate:
        run_candidate(args.candidate, args.pause)
    if args.drive:
        for name in CANDIDATES:
            if _complete(name):
                print(f"[{name}] already done", flush=True)
                continue
            subprocess.run([sys.executable, "-u", __file__, "--candidate", name, "--pause", str(args.pause)], check=False)
    if args.report or args.drive:
        text = report()
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / "summary.md").write_text(text, encoding="utf-8")
        sys.stdout.buffer.write(text.encode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
