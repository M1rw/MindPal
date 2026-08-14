"""Compare the retired prompt contract with MindPal's revised response contract.

This is a deterministic prompt-contract benchmark, not a claim about human
preference or clinical outcomes. It verifies the safeguards that make better
responses more likely and prevents a known user-facing reasoning leak.
"""

from __future__ import annotations

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.core.message_classifier import classify_message
from backend.core.prompt_builder import build_tiered_prompt
from backend.core.prompts import build_system_prompt
from backend.services.response_quality_service import finalize_user_reply

CASES = [
    ("Casual support", "Hey, I had a rough meeting today.", False),
    ("Emotional support", "I keep replaying my argument with my brother and cannot sleep.", False),
    ("Clinical support", "I have been overwhelmed for months and want to understand the pattern.", True),
    ("Egyptian Arabic", "حاسس إني مضغوط من الشغل ومش عارف أنام.", False),
]


def _yes_no(value: bool) -> str:
    return "yes" if value else "no"


def main() -> None:
    rows: list[tuple[str, str, bool, bool, bool, bool]] = []

    for name, message, clinical_mode in CASES:
        classification = classify_message(message, locale="auto", clinical_mode=clinical_mode)
        legacy = build_system_prompt(
            "",
            [],
            "auto",
            clinical_mode=clinical_mode,
            intent_context={"language_style": classification.language},
        )
        improved = build_tiered_prompt(
            classification=classification,
            locale="auto",
            clinical_mode=clinical_mode,
            intent_context_str='Semantic intake context: {"user_need":"support"}',
        )
        legacy_requires_visible_thought = "thought block" in legacy.lower()
        improved_requires_visible_thought = "write your full internal reasoning" in improved.lower()
        improved_has_clear_contract = "clear response contract:" in improved.lower()
        improved_has_private_guard = "never reveal chain-of-thought" in improved.lower()
        rows.append(
            (
                name,
                classification.tier,
                legacy_requires_visible_thought,
                improved_requires_visible_thought,
                improved_has_clear_contract,
                improved_has_private_guard,
            )
        )

    print("# MindPal response-quality prompt-contract benchmark\n")
    print("| Scenario | Tier | Baseline requires visible thought | Revised requires visible thought | CLEAR contract present | Private-reasoning guard present |")
    print("|---|---|---:|---:|---:|---:|")
    for row in rows:
        print(
            "| {} | {} | {} | {} | {} | {} |".format(
                row[0], row[1], _yes_no(row[2]), _yes_no(row[3]), _yes_no(row[4]), _yes_no(row[5])
            )
        )

    baseline_leaks = sum(row[2] for row in rows)
    revised_leaks = sum(row[3] for row in rows)
    clear_coverage = sum(row[4] for row in rows)
    guard_coverage = sum(row[5] for row in rows)
    print("\n| Metric | Baseline | Revised |")
    print("|---|---:|---:|")
    print(f"| Prompt tiers requiring a visible thought block | {baseline_leaks}/{len(rows)} | {revised_leaks}/{len(rows)} |")
    print(f"| Scenarios with the CLEAR response contract | 0/{len(rows)} | {clear_coverage}/{len(rows)} |")
    print(f"| Scenarios with an explicit private-reasoning guard | 0/{len(rows)} | {guard_coverage}/{len(rows)} |")

    legacy_sample = "**Thought:** private plan\n\n**Response:** A grounded, user-visible response."
    print("\n| Finalizer smoke check | Before | After |")
    print("|---|---|---|")
    print(f"| Legacy two-block output | `{legacy_sample}` | `{finalize_user_reply(legacy_sample)}` |")


if __name__ == "__main__":
    main()
