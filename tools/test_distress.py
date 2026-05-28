from pathlib import Path
import sys
root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root))

from src.utils.ai_companion_config import DISTRESS_PATTERNS
import re

samples = [
    ("I want to kill myself", "expected: crisis"),
    ("I'm having a panic attack right now", "expected: anxiety"),
    ("I feel so hopeless and worthless", "expected: depression"),
    ("I'm completely burnt out at work", "expected: burnout"),
    ("I'm a little worried about the exam", "expected: anxiety"),
    ("I can't keep up with everything", "expected: burnout"),
    ("Life is great today!", "expected: none"),
    ("I might hurt myself", "expected: crisis"),
    ("Thinking about suicide makes me scared", "expected: crisis"),
    ("I'm exhausted", "expected: burnout or none depending on phrase"),
]

for text, note in samples:
    normalized = text.casefold()
    matched = None
    for category, patterns in DISTRESS_PATTERNS.items():
        for pattern in patterns:
            if re.search(pattern, normalized, re.IGNORECASE):
                matched = category
                break
        if matched:
            break
    print(f"{text!r} -> {matched!r} ({note})")
