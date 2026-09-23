#!/usr/bin/env python
"""Rank OpenRouter's live free models for the live-voice crisis classifier.

OpenRouter's free roster changes constantly - models appear, get deprecated, and
stealth models come and go - so a hardcoded pick in a config file goes stale
within weeks. This reads the catalog at runtime and scores it against what THIS
job actually needs.

The job is narrow and unusual:

  - one JSON object out, three possible labels, <= 80 tokens
  - temperature 0, called on every user final during a live call
  - must read meaning in any language; Arabic is a first-class case here
  - latency is a product constraint, not a preference: the live-voice mic gate
    caps at 600 ms and Gemini Live ends a user turn after ~700 ms of silence
  - a wrong label either pauses a healthy call or misses real danger

So the ranking deliberately does NOT reward the things a general leaderboard
rewards. Huge context, image input, and 131k max output are all irrelevant here;
a 200 B reasoning model that thinks for four seconds is actively worse than a
small one that answers in 200 ms.

This produces a shortlist. It does not produce a decision - only
validate_voice_classifier.py can do that, because only it measures labels.

Usage:
    python scripts/eval/rank_openrouter_free.py
    python scripts/eval/rank_openrouter_free.py --top 6 --json   # feed the validator
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # pragma: no cover
        pass

CATALOG_URL = "https://openrouter.ai/api/v1/models"

# Families with documented strong multilingual coverage including Arabic. Qwen and
# Gemma are trained on notably broad multilingual corpora; Mistral and Llama are
# competent but thinner on Arabic. This is a prior, not a measurement - the
# fixture set contains four Arabic cases precisely so it can be checked.
ARABIC_STRONG = ("qwen", "gemma", "aya", "command")
ARABIC_FAIR = ("llama", "mistral", "deepseek", "glm", "minimax")

# Reasoning models emit long chains before answering. For a 3-way label at
# temperature 0 that is pure latency on a path with a 600 ms budget. The id is a
# weak signal; `supported_parameters` carrying a reasoning knob is the real one.
REASONING_MARKERS = ("r1", "reasoning", "thinking", "-think", "qwq", "o1", "o3")
REASONING_PARAMS = ("reasoning", "include_reasoning")

# Purpose-built moderation/guardrail models. These are the right SHAPE for this
# job even when they lack a generic JSON mode, because a guardrail model emits a
# safety verdict natively. They get their own section rather than being dropped.
GUARDRAIL_MARKERS = ("content-safety", "guard", "shieldgemma", "moderation", "safety")

# Router aliases pick a different upstream per request. Whatever else that is, it
# is not something to put behind a decision that can pause a call in distress.
ROUTER_ALIASES = ("openrouter/free", "openrouter/auto")


def fetch_catalog(timeout_s: float = 30.0) -> List[Dict[str, Any]]:
    import httpx

    response = httpx.get(CATALOG_URL, timeout=timeout_s)
    response.raise_for_status()
    data = response.json().get("data")
    if not isinstance(data, list):
        raise SystemExit("OpenRouter catalog did not return a model list")
    return data


def is_free(model: Dict[str, Any]) -> bool:
    pricing = model.get("pricing") or {}
    try:
        prompt = float(pricing.get("prompt") or 0)
        completion = float(pricing.get("completion") or 0)
    except (TypeError, ValueError):
        return False
    return prompt == 0 and completion == 0


def parse_params(model: Dict[str, Any]) -> float:
    """Billions of parameters, from the id. 0 when unknown (stealth models)."""
    import re

    match = re.search(r"(\d+(?:\.\d+)?)\s*b\b", str(model.get("id", "")).lower())
    return float(match.group(1)) if match else 0.0


def score(model: Dict[str, Any]) -> Tuple[float, Dict[str, Any]]:
    """Score a model for THIS job. Higher is better. Returns (score, reasons)."""
    model_id = str(model.get("id", "")).lower()
    supported = {str(p).lower() for p in (model.get("supported_parameters") or [])}
    arch = model.get("architecture") or {}
    modalities = {str(m).lower() for m in (arch.get("input_modalities") or [])}
    params_b = parse_params(model)

    points = 0.0
    notes: List[str] = []
    blockers: List[str] = []

    # --- Hard requirements -----------------------------------------------------
    # Without structured output the classifier has to regex a label out of prose,
    # which is exactly the keyword matching this system forbids on the voice path.
    if "response_format" in supported:
        points += 30
        notes.append("json mode")
    else:
        blockers.append("no response_format: cannot guarantee a JSON label")

    if "temperature" in supported:
        points += 5
    else:
        blockers.append("no temperature: cannot pin determinism at 0")

    outputs = {str(m).lower() for m in (arch.get("output_modalities") or [])}
    if "text" not in modalities:
        blockers.append("does not accept text")
    # Lyria ranked highly on structured-output support alone - it is a music
    # generation model that happens to expose response_format. An output modality
    # other than text means it is not doing this job.
    if outputs and outputs != {"text"}:
        blockers.append(f"outputs {'+'.join(sorted(outputs))}, not a text classifier")

    if model_id in ROUTER_ALIASES:
        blockers.append("router alias: picks a different model per request")

    # --- Latency ---------------------------------------------------------------
    # A reasoning model is a liability here, not a feature.
    # Supporting a reasoning knob is not the same as reasoning by default, and
    # the catalog does not expose the default. The client sends
    # reasoning={"enabled": false} on this path, so a model that merely EXPOSES
    # the knob is fine. An id that advertises reasoning as the product is not:
    # those tend to chain regardless.
    reasoning_by_name = any(marker in model_id for marker in REASONING_MARKERS)
    reasoning_knob = any(param in supported for param in REASONING_PARAMS)
    if reasoning_by_name:
        points -= 25
        notes.append("reasoning-first model: chains regardless, blows the 600ms gate")
    elif reasoning_knob:
        points += 3
        notes.append("reasoning disablable")
    # Smaller is faster, and a 3-way label does not need a frontier model.
    if 0 < params_b <= 12:
        points += 20
        notes.append(f"{params_b:g}B: fast class")
    elif 12 < params_b <= 40:
        points += 12
        notes.append(f"{params_b:g}B: mid class")
    elif params_b > 100:
        points -= 8
        notes.append(f"{params_b:g}B: heavy for a 3-way label")
    elif params_b == 0:
        notes.append("size unknown")

    # --- Multilingual ----------------------------------------------------------
    if any(family in model_id for family in ARABIC_STRONG):
        points += 18
        notes.append("strong multilingual family")
    elif any(family in model_id for family in ARABIC_FAIR):
        points += 8
        notes.append("fair multilingual family")
    else:
        notes.append("multilingual coverage unknown")

    # --- Stability -------------------------------------------------------------
    # Stealth/preview slugs vanish without notice. Fine to benchmark, not to pin
    # a safety path to.
    if "stealth" in model_id or model.get("expiration_date"):
        points -= 15
        notes.append("stealth/expiring: do not pin a safety path to this")

    # Context beyond a few thousand tokens is irrelevant: the classifier sees a
    # 600-char rolling window. Reward nothing for a 1M window.
    context = int(model.get("context_length") or 0)
    if context < 4000:
        blockers.append(f"context {context} too small for the transcript window")

    if "tools" in supported:
        points += 2  # weak signal of instruction-following maturity

    guardrail = any(marker in model_id for marker in GUARDRAIL_MARKERS)
    if guardrail:
        # Drop the JSON-mode blocker: a guardrail model returns a verdict by
        # design. It still has to be validated on the real labels like anything
        # else, but it does not belong in the reject pile.
        blockers = [b for b in blockers if "response_format" not in b]
        points += 25
        notes.insert(0, "purpose-built guardrail model")

    return points, {
        "notes": notes,
        "blockers": blockers,
        "params_b": params_b,
        "context": context,
        "guardrail": guardrail,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--top", type=int, default=8, help="how many to shortlist")
    parser.add_argument("--json", action="store_true", help="emit ids only, comma-separated")
    parser.add_argument("--all", action="store_true", help="include models with blockers")
    args = parser.parse_args()

    catalog = fetch_catalog()
    free = [m for m in catalog if is_free(m)]

    ranked: List[Tuple[float, Dict[str, Any], Dict[str, Any]]] = []
    for model in free:
        points, reasons = score(model)
        ranked.append((points, model, reasons))
    ranked.sort(key=lambda row: row[0], reverse=True)

    eligible = [row for row in ranked if not row[2]["blockers"]]
    rejected = [row for row in ranked if row[2]["blockers"]]

    if args.json:
        pool = ranked if args.all else eligible
        print(",".join(str(m.get("id")) for _s, m, _r in pool[: args.top]))
        return 0

    print(f"OpenRouter free models, ranked for the live-voice crisis classifier")
    print(f"  catalog: {len(catalog)} models, {len(free)} at zero price")
    print(f"  eligible: {len(eligible)}   rejected: {len(rejected)}")
    print()
    print("  Scored for: JSON mode, low latency, multilingual, stability.")
    print("  NOT scored for: context size, image input, general benchmark rank.")
    print()

    print(f"  {'#':<3} {'score':>6}  {'model id':<48} {'ctx':>8}  why")
    print(f"  {'-' * 3} {'-' * 6}  {'-' * 48} {'-' * 8}  {'-' * 40}")
    for index, (points, model, reasons) in enumerate(eligible[: args.top], start=1):
        model_id = str(model.get("id"))
        ctx = f"{reasons['context'] // 1000}k" if reasons["context"] else "?"
        why = "; ".join(reasons["notes"][:3])
        print(f"  {index:<3} {points:>6.0f}  {model_id:<48} {ctx:>8}  {why}")

    if rejected:
        print()
        print("  Rejected (cannot serve this job):")
        for _points, model, reasons in rejected[:10]:
            print(f"    {str(model.get('id')):<48} {reasons['blockers'][0]}")

    print()
    print("  This is a shortlist, not a decision. Score the top few on real labels:")
    ids = ",".join(str(m.get("id")) for _s, m, _r in eligible[: min(3, args.top)])
    print(f"    python scripts/eval/validate_voice_classifier.py --provider openrouter \\")
    print(f"      --models {ids} --repeat 2")
    print()
    print("  Then check the data policy for whichever survives. Free OpenRouter")
    print("  variants route to upstreams with differing terms, and these are")
    print("  crisis-disclosure transcripts.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
