"""The insight a reply should add, chosen per turn from many signals. No AI call.

Prompts v2 fixed reply *shape* (short, focused, no stock lines) and the judge
scores showed the cost: replies mirrored more and offered less (insight 3.58 ->
3.42). "Add one useful thing" is too vague for a small model to act on, so this
module decides *which* useful thing, and hands the model a concrete hook taken
from the person's own words.

Signals read each turn (English and Arabic, several dialects):
  intent        greeting / thanks / test, factual question, request for help,
                venting, good news
  thinking      absolutes ("always", "never", "كل", "محد"), self-verdicts
                ("I'm so stupid", "انا غبي"), "should" pressure ("لازم"),
                tension ("I'm fine but...", "بس"), vagueness ("idk", "مدري")
  context       people named, topics that keep recurring across turns, what is
                remembered about them, how heavy the conversation is getting
  the last reply  did it just ask a question? offer a step? use this move?
  the person    which moves have helped them before (thumbs and implicit
                reactions, learned per account in backend.domain.adaptation)

Each candidate move is scored from those signals; the best one becomes a short
note in the system prompt, e.g.
  [Insight for this reply: they said "always" about themselves. Gently test
   the absolute against one real exception; don't argue.]
The chosen move travels with the reply so feedback can credit it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence

from backend.domain.adaptation.profile import normalize_text

# ── Lexicons (matched against normalize_text output: lowercase, Arabic folded) ──

def _rx(pattern: str) -> re.Pattern[str]:
    return re.compile(pattern, re.IGNORECASE)


_GREETING = _rx(
    r"^\s*(hi|hey|hello|yo|sup|hiya|good (morning|evening|night)|testing|test|ok|okay|k|thanks|thank you|thx|ty|lol|haha|cool|nice)\b[\s!.?]*$"
    r"|^\s*(هلا|مرحبا|اهلا|السلام عليكم|شكرا|تمام|اوكي|ههه+)[\s!.؟]*$"
)
_QUESTION_FACT = _rx(
    r"^(how (many|much|long|often)|what (is|are|'s)|when (is|do|does|should)|which|who|where|can you (recommend|explain|tell))\b"
    r"|^(كم|ايش هو|وش هو|ما هو|متى|وين|مين)\b"
)
_HELP = _rx(
    r"\b(what should i|how (do|can|should) i|help me|any (tips|ideas|advice)|should i|what would you do|what can i)\b"
    r"|وش اسوي|ايش اسوي|شو اعمل|اعمل ايه|انصحني|ساعدني|كيف اقدر|وش تنصحني"
)
_ABSOLUTE = _rx(
    r"\b(always|never|everyone|everybody|no one|nobody|nothing|everything|every time|all the time|ruin(ed|s)? everything)\b"
    r"|دايم|دائما|ابدا|كل مره|كل شي|محد|ما احد|ولا احد|الكل|ولا شي|ما في شي"
)
_SELF_VERDICT = _rx(
    r"\b(i'?m (so |such an? |a )?(stupid|idiot|failure|useless|worthless|loser|mess|disaster|joke)|i hate myself|my fault|i ruin|i suck)\b"
    r"|انا غبي|انا غبيه|انا فاشل|انا فاشله|ما اسوى|ذنبي|غلطتي|اكره نفسي|انا ما انفع"
)
_SHOULD = _rx(r"\b(should|have to|has to|must|supposed to|ought to|need to)\b|لازم|المفروض|يجب|مفروض")
_TENSION = _rx(r"\b(but|though|although|part of me|at the same time|yet)\b|\bبس\b|لكن|بالرغم|مع ان")
_VAGUE = _rx(
    r"\b(stuck|meh|idk|i don'?t know|not sure|confused|lost|numb|blah|off|weird|empty)\b"
    r"|مدري|ما ادري|مش عارف|ضايع|واقف مكاني|تايه|مو عارف|ملل"
)
_GOOD_NEWS = _rx(
    r"\b(finally|passed|got the (job|offer)|i did it|promoted|graduated|accepted|won|proud|so happy|engaged|good news)\b"
    r"|تخرجت|نجحت|انقبلت|اخيرا|قبلوني|ترقيت|فرحان|فرحانه|مبسوط|خبر حلو"
)
_PEOPLE = _rx(
    r"\b(my (mom|mum|mother|dad|father|sister|brother|wife|husband|partner|girlfriend|boyfriend|friend|boss|manager|son|daughter|kids?|family|teacher|colleague|coworker|roommate))\b"
    r"|امي|ابوي|ابي|اختي|اخوي|زوجي|زوجتي|صديقي|صديقتي|مديري|مديرتي|ولدي|بنتي|اهلي|خطيبي|خطيبتي|صاحبي|صاحبتي|استاذي"
)
_WORD = re.compile(r"[a-zء-ي']{3,}")

# ── Moves ───────────────────────────────────────────────────────────────────────

MOVES: Dict[str, str] = {
    "answer": "Answer the question plainly and correctly first; add one practical, specific tip only if it genuinely helps.",
    "test_absolute": "They said {hook}. Gently test that absolute against one real exception, or ask for one. Don't argue with them.",
    "self_kindness": "They judged themselves ({hook}). Separate what happened from the verdict about who they are, in one plain sentence.",
    "name_tension": "There are two pulls in what they said ({hook}). Name both plainly; both can be true at once.",
    "unpack_should": "They feel a {hook} pressing on them. Wonder whose rule that is, or what would happen if they didn't.",
    "connect_thread": "{hook} keeps coming back in this conversation. Point that out gently; it may matter more than it seems.",
    "memory_callback": "You remember something relevant: {hook}. Connect it naturally, the way a friend who was listening would.",
    "sharpen": "What they feel is vague ({hook}). Offer two concrete versions of what it might be, so they can pick one instead of explaining from scratch.",
    "values": "Their frustration with {hook} says something about what they care about. Name that value.",
    "micro_step": "They want a way forward. Offer ONE concrete step small enough to do today, tied to their exact situation, not a list.",
    "savor": "Good news ({hook}). Celebrate it specifically, then help them notice what they did to make it happen.",
    "new_angle": "They've been circling the same feeling for a while and questions aren't moving it. Don't ask another; offer a perspective they haven't heard yet.",
    "stay": "The conversation is getting heavier. No technique and no fixing: name what they feel precisely and stay with it.",
}
QUESTION_MOVES = frozenset({"sharpen"})  # moves that end in a question by design


@dataclass(frozen=True)
class InsightPlan:
    move: str  # "" when the turn needs no insight (a greeting, a thank-you)
    hook: str
    note: str
    scores: Dict[str, float] = field(default_factory=dict)


def _quote(match: Optional[re.Match[str]]) -> str:
    return f'"{match.group(0).strip()}"' if match else ""


def _last_assistant(history: Sequence[Any]) -> str:
    for item in reversed(list(history or [])):
        role = str(item.get("role") if isinstance(item, dict) else getattr(item, "role", "") or "").lower()
        if role in {"assistant", "model"}:
            return str((item.get("content") if isinstance(item, dict) else getattr(item, "content", "")) or "")
    return ""


def _user_turns(history: Sequence[Any]) -> List[str]:
    turns: List[str] = []
    for item in history or []:
        role = str(item.get("role") if isinstance(item, dict) else getattr(item, "role", "") or "").lower()
        if role in {"user", "human"}:
            turns.append(str((item.get("content") if isinstance(item, dict) else getattr(item, "content", "")) or ""))
    return turns


def _memory_hook(message: str, memory_text: str) -> str:
    """A remembered fact that shares a meaningful word with this message."""
    if not memory_text:
        return ""
    words = {w for w in _WORD.findall(normalize_text(message)) if len(w) >= 4}
    if not words:
        return ""
    for line in memory_text.splitlines():
        fact = line.strip().lstrip("-").strip()
        if not fact or fact.endswith(":") or len(fact) > 160:
            continue
        if words & set(_WORD.findall(normalize_text(fact))):
            return fact
    return ""


def learned_move_bias(profile: Mapping[str, Any]) -> Dict[str, float]:
    """Per-account move preferences from feedback (Beta stats), roughly [-0.8, 0.8]."""
    bias: Dict[str, float] = {}
    for move, stats in ((profile or {}).get("moves") or {}).items():
        if move not in MOVES or not isinstance(stats, Mapping):
            continue
        alpha, beta = float(stats.get("alpha", 1.0)), float(stats.get("beta", 1.0))
        evidence = alpha + beta - 2.0
        if evidence <= 0:
            continue
        bias[move] = round((alpha / (alpha + beta) - 0.5) * 1.6 * min(1.0, evidence / 4.0), 4)
    return bias


def plan_insight(
    message: str,
    *,
    history: Sequence[Any] = (),
    recurring: Sequence[str] = (),
    direction: str = "steady",
    memory_text: str = "",
    strategy: str = "",
    learned: Optional[Mapping[str, Any]] = None,
    last_move: str = "",
) -> InsightPlan:
    text = normalize_text(message or "")
    if not text.strip() or _GREETING.search(text):
        return InsightPlan("", "", "")

    last_reply = _last_assistant(history)
    last_asked = last_reply.rstrip().endswith(("?", "؟"))
    earlier_user = _user_turns(history)
    venting_turns = sum(1 for t in earlier_user[-4:] if len(t.split()) >= 4)

    absolute = _ABSOLUTE.search(text)
    verdict = _SELF_VERDICT.search(text)
    should = _SHOULD.search(text)
    tension = _TENSION.search(text)
    vague = _VAGUE.search(text)
    good = _GOOD_NEWS.search(text)
    person = _PEOPLE.search(text)
    fact_q = _QUESTION_FACT.search(text) and ("?" in message or "؟" in message or _QUESTION_FACT.match(text))
    help_q = _HELP.search(text)
    memory = _memory_hook(message, memory_text)
    thread = next((w for w in recurring if w), "")

    scores: Dict[str, float] = {m: 0.0 for m in MOVES}
    hooks: Dict[str, str] = {}

    if fact_q and not help_q:
        scores["answer"] += 3.0
    if help_q:
        scores["micro_step"] += 2.4
    if absolute:
        scores["test_absolute"] += 2.2
        hooks["test_absolute"] = _quote(absolute)
    if verdict:
        scores["self_kindness"] += 2.8
        hooks["self_kindness"] = _quote(verdict)
        scores["test_absolute"] -= 0.6  # the verdict is the sharper hook
    if should:
        scores["unpack_should"] += 2.0
        hooks["unpack_should"] = _quote(should)
        # "I have to finish everything" is about the pressure, not a thinking error.
        scores["test_absolute"] -= 0.5
    if tension and len(text.split()) >= 5:
        scores["name_tension"] += 1.7
        hooks["name_tension"] = _quote(tension) + " in what they said"
    if vague:
        scores["sharpen"] += 2.0 if len(text.split()) <= 12 else 1.0
        hooks["sharpen"] = _quote(vague)
    if good and not verdict:
        scores["savor"] += 3.0
        hooks["savor"] = _quote(good)
    if person and not help_q:
        scores["values"] += 1.1
        hooks["values"] = person.group(0).strip()
    if thread:
        scores["connect_thread"] += 2.0
        hooks["connect_thread"] = f'"{thread}"'
    if memory:
        scores["memory_callback"] += 1.9
        hooks["memory_callback"] = memory
    if direction == "heavier":
        scores["stay"] += 2.6
        for technique in ("test_absolute", "unpack_should", "micro_step", "sharpen"):
            scores[technique] -= 1.0
    if venting_turns >= 3 and last_asked and not help_q and not fact_q:
        scores["new_angle"] += 2.2

    # Strategy agreement: the selector already weighed the message as a whole.
    if strategy == "Cognitive Tools":
        for m in ("test_absolute", "self_kindness", "unpack_should"):
            scores[m] += 0.6
    elif strategy == "Guided Coach":
        scores["micro_step"] += 0.6
    elif strategy == "Active Listen":
        for m in ("stay", "values", "name_tension"):
            scores[m] += 0.4

    # The last reply: don't repeat the move, and don't stack questions.
    if last_move in scores:
        scores[last_move] -= 1.2
    if last_asked:
        for m in QUESTION_MOVES:
            scores[m] -= 0.8

    for move, delta in learned_move_bias(learned or {}).items():
        scores[move] += delta

    best = max(scores, key=lambda m: scores[m])
    if scores[best] < 1.0:
        # Nothing specific to hold on to: the base prompt's "one useful thing" stands.
        return InsightPlan("", "", "", {k: round(v, 2) for k, v in scores.items() if v})
    hook = hooks.get(best, "")
    note = MOVES[best].format(hook=hook or "what they said")
    return InsightPlan(best, hook, f"[Insight for this reply: {note}]", {k: round(v, 2) for k, v in scores.items() if v})
