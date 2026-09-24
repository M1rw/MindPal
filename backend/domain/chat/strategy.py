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


# One or two sentences each: the base prompt owns reply shape and length, these
# only say what this turn needs. v1 asked for "deep validation ... somatic
# grounding" on every sad message, which read as permission to write an essay.
DIRECTIVES = {
    "reflect": (
        "Strategy: Active Empathetic Reflection. They are hurting right now. Stay with the feeling before any advice: "
        "name what you notice in their own words, briefly and specifically. Offer a grounding idea only if they seem flooded, "
        "and no advice unless they ask for it."
    ),
    "cognitive": (
        "Strategy: Cognitive Tools. They are caught in a harsh or all-or-nothing thought. Help them look at it from a step back: "
        "one evidence question or a kinder, truer way to see it. Do not argue or lecture."
    ),
    "coach": (
        "Strategy: Guided Solution Coaching. They want clarity or a next step. Name the real choice, offer a concrete idea or two, "
        "and leave the decision with them."
    ),
    "presence": (
        "Strategy: Mindful Presence. Talk like a friend who is paying attention: react to what they said and add one thought or question."
    ),
}
