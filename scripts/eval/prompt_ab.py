"""A/B the chat system prompt across languages with the judged eval.

    python scripts/eval/prompt_ab.py                                  # all variants, all languages
    python scripts/eval/prompt_ab.py --variants v2,v3 --langs es,fr
    python scripts/eval/prompt_ab.py --report-only                    # re-summarize saved runs

Cases: data/evals/multilingual.json (10 languages) plus the Egyptian-Arabic
regression cases from conversations.json. Each variant is patched into the
orchestrator, run through the real pipeline, shape-scored and judged on the
same rubric by the same judge model. One report per variant is saved to
artifacts/evals/ab/<variant>.json (existing ones are reused), and the
comparison is written to artifacts/evals/ab/summary.md.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path
from typing import Any, Dict, List

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

OUT = ROOT / "artifacts" / "evals" / "ab"

_COMPACT_UNDERSTAND = (
    "\n"
    "Read closely:\n"
    "- Keep every detail exactly as they gave it: who, what, numbers, and what is negated. Never add facts they did not say.\n"
    "- Answer the worry underneath, not only the surface words.\n"
    "- If they challenge something you said earlier, check it. If it was wrong, say so in one short line, then help.\n"
    "- Never repeat a question you already asked.\n"
    "- If you are unsure what they mean, say what you understood in a few words instead of guessing.\n"
    "- Where the language marks gender, do not assume theirs.\n"
)

_THINK_FIRST = (
    "\n"
    "Before you write, silently check three things: what exactly happened (who, what, what is negated), "
    "what they are really worried about, and whether they are reacting to something you said earlier. "
    "Then write only the reply, never the check.\n"
)

_REACT_FIRST = (
    "\n"
    "Read closely: stay with the exact facts they gave (never add or flip any). If they push back on something you said, "
    "agree in one short line when they are right and move on. Never repeat a question you already asked.\n"
)


def variants() -> Dict[str, str]:
    from backend.configs import prompts

    return {
        "v1": prompts._CHAT_SYSTEM_BASE_V1,
        "v2": prompts._CHAT_SYSTEM_BASE_V2,
        "v3": prompts._CHAT_SYSTEM_BASE_V3,
        "v4_compact": prompts._CHAT_SYSTEM_BASE_V2 + _COMPACT_UNDERSTAND,
        "v4_think": prompts._CHAT_SYSTEM_BASE_V2 + _COMPACT_UNDERSTAND + _THINK_FIRST,
        "v4_short": prompts._CHAT_SYSTEM_BASE_V2 + _REACT_FIRST,
    }


def load_cases(langs: List[str]) -> List[Dict[str, Any]]:
    from backend.tools.evals import load_cases as load

    cases = load(ROOT / "data" / "evals" / "multilingual.json")
    cases += [c for c in load() if c["id"].startswith("ar-eg-understand")]
    if langs:
        cases = [c for c in cases if c["lang"] in langs]
    return cases


def run_variant(name: str, text: str, cases: List[Dict[str, Any]], judge_provider: str, pause: float = 2.0) -> Dict[str, Any]:
    from backend.domain.chat import orchestrator
    from backend.tools.evals import run_judged

    from backend.infra.llm import gateway as gateway_module

    original = orchestrator.CHAT_SYSTEM_BASE
    original_ladder = gateway_module._ladder
    orchestrator.CHAT_SYSTEM_BASE = text
    # A rate-limited reply must be retried on the model under test, never answered by a spare:
    # one spare reply would put two models into one variant's score.
    gateway_module._ladder = lambda primary: original_ladder(primary)[:1]  # type: ignore[assignment]
    try:
        report = run_judged(cases, judge=True, judge_provider=judge_provider, pause_seconds=pause)
    finally:
        orchestrator.CHAT_SYSTEM_BASE = original
        gateway_module._ladder = original_ladder  # type: ignore[assignment]
    report["variant"] = name
    report["prompt_chars"] = len(text)
    return report


def row_overall(row: Dict[str, Any]) -> float | None:
    from backend.tools.evals import CRITERIA

    vals = [float(row["scores"][c]) for c in CRITERIA if isinstance(row["scores"].get(c), (int, float))]
    return round(statistics.mean(vals), 3) if vals else None


def lang_key(row: Dict[str, Any]) -> str:
    return "ar-eg" if row["id"].startswith("ar-eg") else str(row.get("lang"))


def situation(row: Dict[str, Any]) -> str:
    rid = row["id"]
    for suffix, label in (("-emo", "misread-prone"), ("-own", "own-the-mistake"), ("-light", "greeting"), ("-advice", "advice")):
        if rid.endswith(suffix):
            return label
    return "own-the-mistake" if rid.endswith(("-03", "-04")) else "misread-prone"


def _needs_rerun(row: Dict[str, Any]) -> bool:
    return not row.get("reply") or row_overall(row) is None


def resume_variant(name: str, text: str, path: Path, cases: List[Dict[str, Any]], judge_provider: str) -> Dict[str, Any]:
    """Rerun only the failed rows of a saved report (slowly, to stay under the token cap) and merge them in."""
    from backend.tools.evals import summarize

    report = json.loads(path.read_text(encoding="utf-8"))
    todo = {r["id"] for r in report["rows"] if _needs_rerun(r)}
    todo_cases = [c for c in cases if c["id"] in todo]
    if not todo_cases:
        print(f"[{name}] nothing to resume", flush=True)
        return report
    print(f"[{name}] resuming {len(todo_cases)} failed rows", flush=True)
    fresh = {r["id"]: r for r in run_variant(name, text, todo_cases, judge_provider, pause=6.0)["rows"]}
    report["rows"] = [fresh[r["id"]] if r["id"] in fresh and not _needs_rerun(fresh[r["id"]]) else r for r in report["rows"]]
    report.update(summarize(report["rows"]))
    report["failed"] = [r["id"] for r in report["rows"] if not r.get("reply")]
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def summarize(reports: Dict[str, Dict[str, Any]]) -> str:
    from backend.tools.evals import CRITERIA

    names = list(reports)
    lines: List[str] = []
    lines.append("# Prompt A/B across languages\n")
    lines.append("Same judge, same cases, one sample per case. Scores are 1-5; shape is 0-100.\n")

    lines.append("## Overall\n")
    lines.append("| variant | chars | cases judged | overall | " + " | ".join(CRITERIA) + " | shape |")
    lines.append("|" + "---|" * (len(CRITERIA) + 5))
    for n in names:
        r = reports[n]
        rows = [x for x in r["rows"] if row_overall(x) is not None]
        crit = [
            str(round(statistics.mean(float(x["scores"][c]) for x in rows if isinstance(x["scores"].get(c), (int, float))), 2))
            for c in CRITERIA
        ]
        overall = round(statistics.mean(row_overall(x) for x in rows), 2) if rows else "-"
        lines.append(f"| {n} | {r.get('prompt_chars')} | {len(rows)}/{r['cases']} | **{overall}** | " + " | ".join(crit) + f" | {r['shape']['mean']} |")

    def table(title: str, keyfn) -> None:
        keys = sorted({keyfn(x) for r in reports.values() for x in r["rows"]})
        lines.append(f"\n## {title}\n")
        lines.append("| " + title.split(' by ')[-1] + " | " + " | ".join(names) + " |")
        lines.append("|" + "---|" * (len(names) + 1))
        for k in keys:
            cells = []
            for n in names:
                vals = [row_overall(x) for x in reports[n]["rows"] if keyfn(x) == k and row_overall(x) is not None]
                cells.append(str(round(statistics.mean(vals), 2)) if vals else "-")
            lines.append(f"| {k} | " + " | ".join(cells) + " |")

    table("Overall by language", lang_key)
    table("Overall by situation", situation)

    if "v3" in reports:
        lines.append("\n## Paired wins vs v3 (per case, overall score)\n")
        lines.append("| variant | better | same | worse |")
        lines.append("|---|---|---|---|")
        base = {x["id"]: row_overall(x) for x in reports["v3"]["rows"]}
        for n in names:
            if n == "v3":
                continue
            better = same = worse = 0
            for x in reports[n]["rows"]:
                a, b = row_overall(x), base.get(x["id"])
                if a is None or b is None:
                    continue
                if abs(a - b) < 0.2:
                    same += 1
                elif a > b:
                    better += 1
                else:
                    worse += 1
            lines.append(f"| {n} | {better} | {same} | {worse} |")
    return "\n".join(lines) + "\n"


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--variants", default="", help="comma-separated variant names (default: all)")
    parser.add_argument("--langs", default="", help="comma-separated language codes (default: all)")
    parser.add_argument("--judge-provider", default="groq", choices=("gemini", "openrouter", "groq"))
    parser.add_argument("--report-only", action="store_true")
    parser.add_argument("--resume", action="store_true", help="rerun only the rows that have no reply or no judgment, keep the rest")
    parser.add_argument("--force", action="store_true", help="rerun variants even if a saved report exists")
    args = parser.parse_args(argv)

    all_variants = variants()
    wanted = [v for v in args.variants.split(",") if v] or list(all_variants)
    cases = load_cases([x for x in args.langs.split(",") if x])
    OUT.mkdir(parents=True, exist_ok=True)

    reports: Dict[str, Dict[str, Any]] = {}
    for name in wanted:
        path = OUT / f"{name}.json"
        if path.exists() and args.resume and not args.force:
            reports[name] = resume_variant(name, all_variants[name], path, cases, args.judge_provider)
            continue
        if path.exists() and not args.force:
            reports[name] = json.loads(path.read_text(encoding="utf-8"))
            print(f"[{name}] reusing {path.name}", flush=True)
            continue
        if args.report_only:
            continue
        print(f"[{name}] running {len(cases)} cases ({len(all_variants[name])} chars)", flush=True)
        report = run_variant(name, all_variants[name], cases, args.judge_provider)
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        reports[name] = report

    summary = summarize(reports)
    (OUT / "summary.md").write_text(summary, encoding="utf-8")
    sys.stdout.buffer.write(summary.encode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
