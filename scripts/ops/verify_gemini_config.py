#!/usr/bin/env python
"""Verify the live-voice Gemini call config against the real API.

Three distinct failure modes are possible here, and they are NOT the same thing:

  429 / RESOURCE_EXHAUSTED   the call never reached the model. Model quota is
                             exhausted, so the classifier is down - silently.
  empty text                 the call ran and returned nothing, usually
                             finish_reason=MAX_TOKENS with thinking consuming the
                             80-token budget. Billed, and still no verdict.
  a label                    working.

All three surface as `safety_unverified` in the live session, so from inside the
app they are indistinguishable. This script tells them apart, and runs the old
and new classifier configs side by side.

Usage:
    python scripts/ops/verify_gemini_config.py

Reads GEMINI_API_KEY (or GOOGLE_API_KEY) from the environment, falling back to
.env.local then .env. The key is never printed.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

REPO_ROOT = Path(__file__).resolve().parents[2]

# Representative of what the classifier actually sees: neutral chat, venting, and
# a line that should come back distress_support. None are edge cases - the point
# is whether any verdict comes back at all.
PROBES: Tuple[Tuple[str, str], ...] = (
    ("neutral", "User: yeah work was fine, pretty boring honestly\nMindPal: (none)"),
    ("venting", "User: I am so done with all of this, it never stops\nMindPal: (none)"),
    ("distress", "User: I do not really see the point in being here anymore\nMindPal: (none)"),
)

SYSTEM = (
    "Label the USER's meaning as one of not_crisis, distress_support, "
    'imminent_escalate. Reply only as JSON: {"label": "..."}.'
)


def load_key() -> Optional[str]:
    """Environment first, then .env.local, then .env. Never printed."""
    for name in ("GEMINI_API_KEY", "GOOGLE_API_KEY"):
        value = os.environ.get(name, "").strip()
        if value:
            return value

    for filename in (".env.local", ".env"):
        path = REPO_ROOT / filename
        if not path.exists():
            continue
        for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            if key.strip() not in {"GEMINI_API_KEY", "GOOGLE_API_KEY"}:
                continue
            cleaned = value.strip().strip('"').strip("'")
            if cleaned:
                print(f"  (key loaded from {filename})")
                return cleaned
    return None


def run_probe(client: Any, types: Any, *, model: str, thinking: Optional[int]) -> List[Dict[str, Any]]:
    results: List[Dict[str, Any]] = []
    for name, prompt in PROBES:
        kwargs: Dict[str, Any] = {
            "system_instruction": SYSTEM,
            "temperature": 0.0,
            "max_output_tokens": 80,
            "response_mime_type": "application/json",
        }
        if thinking is not None:
            kwargs["thinking_config"] = types.ThinkingConfig(thinking_budget=thinking)

        started = time.perf_counter()
        error = ""
        kind = "ok"
        text = ""
        finish = "?"
        thoughts = 0
        total = 0
        try:
            response = client.models.generate_content(
                model=model,
                contents=prompt,
                config=types.GenerateContentConfig(**kwargs),
            )
            text = (getattr(response, "text", None) or "").strip()
            try:
                finish = str(response.candidates[0].finish_reason)
            except Exception:
                finish = "?"
            usage = getattr(response, "usage_metadata", None)
            thoughts = int(getattr(usage, "thoughts_token_count", 0) or 0)
            total = int(getattr(usage, "total_token_count", 0) or 0)
        except Exception as exc:  # noqa: BLE001 - this is a diagnostic
            error = f"{type(exc).__name__}: {str(exc)[:200]}"
            detail = f"{type(exc).__name__} {exc}".lower()
            # A 429 and an empty body are completely different diagnoses. Counting
            # them in one bucket is what made the first version of this script
            # report a confirmed thinking bug on a run where nothing ran at all.
            kind = "rate_limited" if ("429" in detail or "resource_exhausted" in detail) else "error"
        elapsed_ms = (time.perf_counter() - started) * 1000

        results.append(
            {
                "probe": name,
                "text": text,
                "finish": finish.rsplit(".", 1)[-1],
                "thoughts": thoughts,
                "total": total,
                "ms": elapsed_ms,
                "error": error,
                "kind": kind if error else ("empty" if not text else "ok"),
            }
        )
    return results


def _quota_hint(error: str) -> str:
    """Surface which quota was hit, so a 429 is actionable rather than mysterious."""
    lowered = error.lower()
    for marker in ("free_tier", "quota_metric", "quotaid", "perday", "perminute", "limit:"):
        index = lowered.find(marker)
        if index >= 0:
            return error[max(0, index - 20) : index + 80].strip()
    return ""


def report(label: str, model: str, rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    print()
    print(label)
    print(f"  model: {model}")
    print(f"  {'probe':<10} {'verdict':<34} {'finish':<12} {'thought':>8} {'total':>6} {'ms':>7}")
    print(f"  {'-' * 10} {'-' * 34} {'-' * 12} {'-' * 8} {'-' * 6} {'-' * 7}")
    counts = {"ok": 0, "empty": 0, "rate_limited": 0, "error": 0}
    thoughts = 0
    quota = ""
    for row in rows:
        kind = row["kind"]
        counts[kind] = counts.get(kind, 0) + 1
        if kind == "rate_limited":
            verdict = "429 QUOTA - never reached model"
            quota = quota or _quota_hint(row["error"])
        elif kind == "error":
            verdict = ("ERROR " + row["error"])[:34]
        elif kind == "empty":
            verdict = "(empty -> safety_unverified)"
        else:
            verdict = " ".join(row["text"].split())[:34]
        thoughts += row["thoughts"]
        print(
            f"  {row['probe']:<10} {verdict:<34} {row['finish']:<12} "
            f"{row['thoughts']:>8} {row['total']:>6} {row['ms']:>7.0f}"
        )
    if quota:
        print(f"  quota detail: {quota}")
    # Latency only means something for calls that actually ran. A 429 returns
    # instantly and would otherwise make a broken config look fast.
    ran = [row for row in rows if row["kind"] in {"ok", "empty"}]
    mean_ms = sum(row["ms"] for row in ran) / len(ran) if ran else 0.0
    return {"counts": counts, "thoughts": thoughts, "mean_ms": mean_ms, "ran": len(ran)}


def _latency_cell(summary: Dict[str, Any]) -> str:
    if not summary["ran"]:
        return "n/a"
    return f"{summary['mean_ms']:.0f} ms"


def main() -> int:
    print("Gemini live-voice classifier config check")
    key = load_key()
    if not key:
        print()
        print("  No GEMINI_API_KEY or GOOGLE_API_KEY found in the environment,")
        print("  .env.local, or .env. Set one and re-run.")
        return 2

    try:
        from google import genai
        from google.genai import types
    except ImportError:
        print()
        print("  google-genai is not installed. `pip install google-genai`")
        return 2

    client = genai.Client(api_key=key)

    old = report(
        "BEFORE  (what shipped: Flash, thinking left at provider default)",
        "gemini-2.5-flash",
        run_probe(client, types, model="gemini-2.5-flash", thinking=None),
    )
    new = report(
        "AFTER   (this branch: Flash-Lite, thinking pinned to 0)",
        "gemini-2.5-flash-lite",
        run_probe(client, types, model="gemini-2.5-flash-lite", thinking=0),
    )

    total = len(PROBES)
    print()
    print("Results")
    print(f"  {'':<18} {'before':>10} {'after':>10}")
    for row_label, field in (
        ("usable labels", "ok"),
        ("empty responses", "empty"),
        ("429 rate limited", "rate_limited"),
        ("other errors", "error"),
    ):
        before = f"{old['counts'].get(field, 0)}/{total}"
        after = f"{new['counts'].get(field, 0)}/{total}"
        print(f"  {row_label:<18} {before:>10} {after:>10}")
    print(f"  {'thinking tokens':<18} {old['thoughts']:>10} {new['thoughts']:>10}")
    print(f"  {'mean latency':<18} {_latency_cell(old):>10} {_latency_cell(new):>10}")

    print()
    print("Verdict")
    if old["counts"].get("rate_limited"):
        print("  MODEL QUOTA EXHAUSTED on gemini-2.5-flash.")
        print("  Those calls never reached the model, so this run says nothing about")
        print("  the thinking-token theory - that stays unverified until flash has quota.")
        print("  What it DOES show: the live-voice crisis classifier was taking 429s and")
        print("  recording safety_unverified. Chat streams on the same model.")
        if new["counts"].get("ok") == total:
            print("  Flash-Lite answered every probe, so the model change restores the path.")
    elif old["counts"].get("empty") and not new["counts"].get("empty"):
        print("  CONFIRMED. The shipped config returned empty text, which the live")
        print("  session recorded as safety_unverified. Pinning thinking resolves it.")
    elif old["thoughts"] and not new["thoughts"]:
        print(f"  PARTIAL. The old config answered, but billed {old['thoughts']} thinking")
        print("  tokens for a 3-way label. Pinning removes that cost and latency.")
    else:
        print("  NOT REPRODUCED on these probes. Keep the pin anyway: it removes the")
        print("  failure mode rather than trusting a provider default to stay favourable.")

    if new["ran"] and new["mean_ms"] > 600:
        print()
        print(f"  Note: classify averages {new['mean_ms']:.0f} ms, above the 600 ms mic-gate cap")
        print("  and above Gemini Live's ~700 ms VAD silence. The cap is load-bearing:")
        print("  without it this round trip would truncate user turns.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
