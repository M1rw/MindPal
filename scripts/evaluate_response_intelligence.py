"""Run deterministic response-intelligence examples.

This evaluates the implemented quality floor; it does not claim to measure
real-user preference or a provider model's clinical performance.
"""

from __future__ import annotations

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.core.config import Settings
from backend.services.domain.llm.message_classifier import classify_message
from backend.services.domain.intelligence import ResponseIntelligenceService

CASES = (
    {
        "name": "English emotional support",
        "message": "I cannot sleep after the argument with my brother.",
        "baseline": "I'm here for you. That sounds hard.",
        "improved": (
            "After an argument with your brother, it makes sense your mind is replaying it. "
            "Try writing the one sentence you wish had landed differently, then put the note away for tonight."
        ),
    },
    {
        "name": "Egyptian Arabic support",
        "message": "حاسس إني مضغوط من الشغل ومش عارف أنام.",
        "baseline": "أنا هنا عشانك. ده صعب.",
        "improved": "واضح إن ضغط الشغل مكمل معاك لحد وقت النوم. جرّب تكتب أكتر حاجة شاغلاك في سطر واحد، وبعدها خد دقيقتين بعيد عن الشاشة.",
    },
)


def main() -> None:
    service = ResponseIntelligenceService(settings=Settings(ENVIRONMENT="test"))
    print("# MindPal response-intelligence control-plane benchmark\n")
    print("| Scenario | Candidate | Score | Generic flag | Missing-step flag | Repair recommended |")
    print("|---|---|---:|---:|---:|---:|")

    for case in CASES:
        classification = classify_message(case["message"])
        brief = service.build_brief(
            user_message=case["message"],
            classification=classification,
            response_mode="normal_support",
        )
        for label in ("baseline", "improved"):
            evaluation = service.evaluate(
                user_message=case["message"],
                reply=case[label],
                brief=brief,
            )
            print(
                "| {scenario} | {label} | {score} | {generic} | {missing_step} | {repair} |".format(
                    scenario=case["name"],
                    label=label,
                    score=evaluation.score,
                    generic="yes" if "generic_without_grounding" in evaluation.issues else "no",
                    missing_step="yes" if "missing_concrete_next_step" in evaluation.issues else "no",
                    repair="yes" if evaluation.repair_recommended else "no",
                )
            )

    print("\n> The baseline and improved replies are fixed test fixtures. This benchmark proves quality-control behavior, not human preference superiority.")


if __name__ == "__main__":
    main()
