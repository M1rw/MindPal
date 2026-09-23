"""Conversational strategy selection.

Scores every strategy from the evidence in the message (English and Arabic)
instead of taking the first regex that matches, then blends in what has
worked for this person before (see backend.domain.adaptation). The winner
comes with a confidence so ambiguous turns lean on learned preference while
clear ones follow the message.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Dict, Mapping, Optional

from backend.domain.adaptation.profile import normalize_text

_DISTRESS = re.compile(
    r"\b(overwhelm\w*|crying|cried|panic\w*|scared|sad|depressed|hopeless|exhausted|hurt|hurts|anxious|anxiety|"
    r"grief|grieving|lonely|alone|broken|can't take|cant take|terrified|heartbroken|miserable|numb|drained)\b"
    r"|حزين|زعلان|خايف|قلق|متوتر|تعبان|مكتئب|وحيد|منهار|ضايق|مخنوق|ابكي|بكيت"
    # Arabic (normalized: alef forms folded, taa marbuta as haa), across dialects.
    r"|مضغوط|مقهور|تعبت|اكتئاب|توتر|خوف|ضيقه|حزن|وحدي|لحالي|انهرت|مو قادر|مش قادر|ما اقدر اتحمل|قلبي يوجعني|ما لي خلق|مالي خلق|زهقان|طفشان"
)
_DISTORTION = re.compile(
    r"\b(always fail\w*|never get|worthless|hate myself|ruined|pointless|everyone hates|terrible person|no way out|"
    r"stupid of me|i'm a failure|im a failure|i am a failure|nothing ever works|i ruin everything|i'm useless|im useless)\b"
    r"|فاشل|ما اسوى شي|كل شي خربته|الكل يكرهني|ما في فايده"
    r"|ما احد يحبني|محد يحبني|كلهم يكرهوني|ما في امل|مافي امل|ما فيه امل|دايم اخرب|انا غبي|انا غبيه|ما اسوى|ما عندي قيمه"
)
_COACHING = re.compile(
    r"\b(what should i|how (do|can) i|help me (decide|plan|figure|choose)|advice|solution|next step\w*|solve|options|"
    r"stuck on|should i|pros and cons|plan for)\b"
    r"|وش اسوي|ايش اسوي|كيف اقدر|انصحني|ساعدني اقرر|ماذا افعل|خطه"
    r"|شو اعمل|اعمل ايه|وش الحل|ايش الحل|شو الحل|ايه الحل|كيف اتصرف|وش تنصحني|ابي حل|عايز حل|بدي حل|خيارات"
)

_BASELINE = 0.3
_CONTAINMENT_PRIORITY = 0.6  # someone in distress is held before they are coached


@dataclass(frozen=True)
class StrategyDecision:
    strategy: str
    directive_key: str
    confidence: float
    scores: Dict[str, float]


def score_strategies(message: str, *, learned_bias: Optional[Mapping[str, float]] = None) -> StrategyDecision:
    text = normalize_text(message)
    distress = len(_DISTRESS.findall(text))
    distortion = len(_DISTORTION.findall(text))
    coaching = len(_COACHING.findall(text))

    scores = {
        "Active Listen": _BASELINE + min(distress, 3) * 1.0 + (_CONTAINMENT_PRIORITY if distress else 0.0),
        "Cognitive Tools": min(distortion, 3) * 1.1,
        "Guided Coach": min(coaching, 3) * 1.0,
    }
    for name, adjustment in (learned_bias or {}).items():
        if name in scores:
            scores[name] = round(scores[name] + float(adjustment), 4)

    ranked = sorted(scores.items(), key=lambda item: item[1], reverse=True)
    best, best_score = ranked[0]
    runner_up = ranked[1][1]
    confidence = round(min(1.0, max(0.0, best_score - runner_up) / 1.5), 3)
    if best == "Active Listen":
        directive_key = "reflect" if distress else "presence"
    elif best == "Cognitive Tools":
        directive_key = "cognitive"
    else:
        directive_key = "coach"
    return StrategyDecision(best, directive_key, confidence, scores)


DIRECTIVES = {
    "reflect": (
        "Strategy: Active Empathetic Reflection. The user is in an emotional or overwhelmed state. "
        "Prioritize deep validation, emotional attunement, non-judgmental containment, and somatic grounding. "
        "DO NOT jump to unsolicited advice or problem-solving yet."
    ),
    "cognitive": (
        "Strategy: Cognitive Tools. The user is caught in cognitive distortion or catastrophic thought loops. "
        "Gently guide them with cognitive defusion, evidence-testing questions, and self-compassion reframing. "
        "Help them observe the thought without identifying fully with it."
    ),
    "coach": (
        "Strategy: Guided Solution Coaching. The user is seeking clarity or action. "
        "Help them deconstruct the challenge into manageable, atomic micro-steps using structured Socratic coaching. "
        "Foster their own agency rather than prescribing rigid answers."
    ),
    "presence": (
        "Strategy: Mindful Presence. Meet the user where they are with warmth, reflective mirroring, "
        "and thoughtful, curious inquiry."
    ),
}
