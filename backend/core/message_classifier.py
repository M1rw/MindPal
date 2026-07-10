# backend/core/message_classifier.py

"""
Deterministic message classifier for MindPal.

Classifies user messages into tiers BEFORE sending to the LLM,
enabling token-optimized prompt assembly and response routing.

Tiers:
  - greeting:      Simple greeting, no thought chain needed
  - meta_question: User asking about MindPal itself
  - off_topic:     Request outside wellness scope
  - crisis:        Immediate safety concern
  - casual:        Light conversation, mini thought chain
  - emotional:     Standard emotional support, full chain
  - clinical:      Deep clinical analysis (Pro only)
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .security import sanitize_text

__all__ = ["MessageClassification", "classify_message"]

# ═══════════════════════════════════════════════════════════════
# Load patterns from JSON (cached at module level)
# ═══════════════════════════════════════════════════════════════

_PROMPTS_DIR = Path(__file__).parent / "prompt_templates"


def _load_json(filename: str) -> dict[str, Any]:
    path = _PROMPTS_DIR / filename
    if not path.exists():
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


_GREETING_DATA = _load_json("greeting_patterns.json")
_LOCALE_DATA = _load_json("locale_rules.json")

# Flatten all greeting words into a single set
_ALL_GREETINGS: set[str] = set()
for _lang_greetings in _GREETING_DATA.get("greeting_words", {}).values():
    _ALL_GREETINGS.update(g.lower() for g in _lang_greetings)

_HOW_ARE_YOU: list[str] = [p.lower() for p in _GREETING_DATA.get("how_are_you_patterns", [])]

_DISTRESS_MARKERS: list[str] = [m.lower() for m in _GREETING_DATA.get("distress_override_markers", [])]

_OFF_TOPIC_CODE: list[str] = [k.lower() for k in _GREETING_DATA.get("off_topic_markers", {}).get("code_keywords", [])]
_OFF_TOPIC_ACADEMIC: list[str] = [k.lower() for k in _GREETING_DATA.get("off_topic_markers", {}).get("academic_keywords", [])]
_OFF_TOPIC_GENERAL_AI: list[str] = [k.lower() for k in _GREETING_DATA.get("off_topic_markers", {}).get("general_ai_keywords", [])]

_META_QUESTIONS: list[str] = [p.lower() for p in _GREETING_DATA.get("meta_question_patterns", [])]

_EGYPTIAN_MARKERS: list[str] = [m.lower() for m in _LOCALE_DATA.get("detection_markers", {}).get("egyptian_markers", [])]


# ═══════════════════════════════════════════════════════════════
# Crisis / emotional markers (kept inline for speed)
# ═══════════════════════════════════════════════════════════════

_CRISIS_MARKERS = (
    "kill myself", "suicide", "end my life", "want to die", "wanna die",
    "hurt myself", "self harm", "self-harm", "cutting myself",
    "مش عايز اعيش", "مش عايزة اعيش", "أموت نفسي", "انتحر",
    "هأذي نفسي", "هاذي نفسي", "عايز اموت", "نفسي اموت",
)

_STRONG_EMOTIONAL_MARKERS = (
    "depressed", "depression", "anxiety", "panic attack", "trauma",
    "abuse", "abused", "neglected", "suicidal thoughts", "self-harm",
    "PTSD", "bipolar", "eating disorder", "addiction",
    "هلع", "اكتئاب", "صدمة", "إساءة", "إدمان",
)

_MODERATE_EMOTIONAL_MARKERS = (
    "stressed", "anxious", "worried", "overwhelmed", "burned out",
    "lonely", "isolated", "lost", "confused", "stuck", "hopeless",
    "angry", "furious", "rage", "crying", "can't sleep", "insomnia",
    "relationship", "breakup", "divorce", "fight", "argument",
    "grief", "loss", "death", "died", "miss them",
    "terrible", "awful", "horrible", "miserable", "broken",
    "تعبان", "تعبانة", "قلقان", "مضايق", "زعلان", "محبط", "وحيد",
    "غضبان", "متعصب", "مش قادر انام", "خلاف", "طلاق",
    "حاسس", "حاسه", "خايف", "خايفة",
)


# ═══════════════════════════════════════════════════════════════
# Classification result
# ═══════════════════════════════════════════════════════════════

@dataclass(frozen=True, slots=True)
class MessageClassification:
    """Result of deterministic message classification."""
    tier: str                    # greeting, casual, emotional, clinical, crisis, off_topic, meta_question
    language: str                # english, arabic, egyptian_arabic
    confidence: float            # 0.0 - 1.0
    signals: tuple[str, ...]     # detected markers/patterns
    skip_thought: bool           # True → no thinking chain
    max_thought_words: int       # 0, 50, 200, 400
    max_response_tokens: int     # suggested max output tokens
    temperature: float           # suggested temperature


# ═══════════════════════════════════════════════════════════════
# Main classifier
# ═══════════════════════════════════════════════════════════════

def classify_message(
    message: str,
    *,
    locale: str = "auto",
    clinical_mode: bool = False,
) -> MessageClassification:
    """
    Classify a user message into a tier for prompt routing.

    This is deterministic (no LLM call) and runs in microseconds.
    The classification drives:
      - Which prompt template to assemble
      - How many tokens to allocate for thinking
      - LLM temperature and max output tokens
    """
    raw = sanitize_text(message or "", 2_000)
    lowered = raw.lower().strip()
    words = lowered.split()
    word_count = len(words)
    signals: list[str] = []

    # ── Language detection ──
    language = _detect_language(raw, lowered)
    signals.append(f"lang:{language}")

    # ── 1. Crisis check (highest priority) ──
    if _contains_any(lowered, _CRISIS_MARKERS):
        signals.append("crisis_markers")
        return MessageClassification(
            tier="crisis",
            language=language,
            confidence=0.95,
            signals=tuple(signals),
            skip_thought=True,
            max_thought_words=0,
            max_response_tokens=200,
            temperature=0.1,
        )

    # ── 2. Meta-question ("what can you do?") ──
    if _contains_any(lowered, _META_QUESTIONS):
        signals.append("meta_question")
        return MessageClassification(
            tier="meta_question",
            language=language,
            confidence=0.90,
            signals=tuple(signals),
            skip_thought=True,
            max_thought_words=0,
            max_response_tokens=600,
            temperature=0.4,
        )

    # ── 3. Off-topic detection ──
    off_topic_score = 0
    if _contains_any(lowered, _OFF_TOPIC_CODE):
        off_topic_score += 2
        signals.append("code_keywords")
    if _contains_any(lowered, _OFF_TOPIC_ACADEMIC):
        off_topic_score += 2
        signals.append("academic_keywords")
    if _contains_any(lowered, _OFF_TOPIC_GENERAL_AI):
        off_topic_score += 3
        signals.append("general_ai_request")

    # Only classify as off-topic if there are NO emotional markers
    if off_topic_score >= 2 and not _contains_any(lowered, _DISTRESS_MARKERS):
        return MessageClassification(
            tier="off_topic",
            language=language,
            confidence=min(0.95, 0.5 + off_topic_score * 0.15),
            signals=tuple(signals),
            skip_thought=True,
            max_thought_words=0,
            max_response_tokens=200,
            temperature=0.3,
        )

    # ── 4. Greeting detection ──
    has_distress = _contains_any(lowered, _DISTRESS_MARKERS)

    if not has_distress:
        is_greeting = False

        # Check exact match for short messages
        if word_count <= 4:
            # Check if entire message is a greeting
            if lowered in _ALL_GREETINGS:
                is_greeting = True
                signals.append("exact_greeting")
            # Check if first word(s) are a greeting and rest is filler
            elif words and words[0] in _ALL_GREETINGS:
                is_greeting = True
                signals.append("starts_with_greeting")
            # Check multi-word greetings
            elif _contains_any(lowered, list(_ALL_GREETINGS)):
                is_greeting = True
                signals.append("contains_greeting")

        # Check "how are you" patterns
        if not is_greeting and _contains_any(lowered, _HOW_ARE_YOU):
            is_greeting = True
            signals.append("how_are_you")

        if is_greeting:
            return MessageClassification(
                tier="greeting",
                language=language,
                confidence=0.95,
                signals=tuple(signals),
                skip_thought=True,
                max_thought_words=0,
                max_response_tokens=300,
                temperature=0.6,
            )

    # ── 5. Strong emotional / clinical content ──
    if _contains_any(lowered, _STRONG_EMOTIONAL_MARKERS):
        signals.append("strong_emotional")
        if clinical_mode:
            return MessageClassification(
                tier="clinical",
                language=language,
                confidence=0.90,
                signals=tuple(signals),
                skip_thought=False,
                max_thought_words=400,
                max_response_tokens=1800,
                temperature=0.3,
            )
        return MessageClassification(
            tier="emotional",
            language=language,
            confidence=0.90,
            signals=tuple(signals),
            skip_thought=False,
            max_thought_words=200,
            max_response_tokens=1200,
            temperature=0.4,
        )

    # ── 6. Moderate emotional content ──
    if _contains_any(lowered, _MODERATE_EMOTIONAL_MARKERS):
        signals.append("moderate_emotional")
        if clinical_mode:
            return MessageClassification(
                tier="clinical",
                language=language,
                confidence=0.80,
                signals=tuple(signals),
                skip_thought=False,
                max_thought_words=400,
                max_response_tokens=1800,
                temperature=0.3,
            )
        return MessageClassification(
            tier="emotional",
            language=language,
            confidence=0.80,
            signals=tuple(signals),
            skip_thought=False,
            max_thought_words=200,
            max_response_tokens=1200,
            temperature=0.4,
        )

    # ── 7. Default: casual conversation ──
    signals.append("default_casual")
    return MessageClassification(
        tier="clinical" if clinical_mode else "casual",
        language=language,
        confidence=0.60,
        signals=tuple(signals),
        skip_thought=not clinical_mode,
        max_thought_words=400 if clinical_mode else 50,
        max_response_tokens=1800 if clinical_mode else 800,
        temperature=0.3 if clinical_mode else 0.5,
    )


# ═══════════════════════════════════════════════════════════════
# Language detection
# ═══════════════════════════════════════════════════════════════

def _detect_language(raw: str, lowered: str) -> str:
    """Detect message language from script and markers."""
    has_arabic = any("\u0600" <= c <= "\u06ff" for c in raw)
    if not has_arabic:
        return "english"

    # Check for Egyptian Arabic markers (from JSON + inline additions)
    egyptian_extras = (
        "ازيك", "ازيكو", "عامل ايه", "عاملة ايه",
        "تعبان", "تعبانة", "حاسس", "حاسه", "بحس",
        "كده", "ليه", "ازاي", "عايز", "عايزة", "مش",
    )
    if any(marker in lowered for marker in _EGYPTIAN_MARKERS) or any(marker in lowered for marker in egyptian_extras):
        return "egyptian_arabic"

    return "arabic"


def _contains_any(haystack: str, needles: list[str] | tuple[str, ...] | set[str]) -> bool:
    """Check if haystack contains any of the needle phrases."""
    return any(needle in haystack for needle in needles)
