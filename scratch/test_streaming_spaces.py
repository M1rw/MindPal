"""
End-to-end debug test for the streaming pipeline.
Simulates exactly what happens when the LLM sends SSE chunks.
"""

import json
import re
import unicodedata

# ===== COPY OF sanitize_text from security.py =====
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_WHITESPACE_RE = re.compile(r"[ \t\f\v]+")
_INVISIBLE_CHARS_RE = re.compile(
    "["
    "\u200b\u200c\u200d\u200e\u200f"
    "\u2060\u2061\u2062\u2063\u2064"
    "\ufeff\ufff9\ufffa\ufffb"
    "]"
)

def sanitize_text(text, max_chars):
    normalized = unicodedata.normalize("NFC", str(text or ""))
    normalized = normalized.replace("\r\n", "\n").replace("\r", "\n")
    normalized = _CONTROL_CHARS_RE.sub("", normalized)
    normalized = _INVISIBLE_CHARS_RE.sub("", normalized)
    lines = []
    for line in normalized.split("\n"):
        lines.append(_WHITESPACE_RE.sub(" ", line).strip())
    cleaned = "\n".join(lines).strip()
    return cleaned[:max_chars] if len(cleaned) > max_chars else cleaned


# ===== COPY OF OLD extract_openai_text (BUGGY) =====
def extract_openai_text_OLD(data, max_chars=80000):
    """OLD version — calls sanitize_text which STRIPS SPACES."""
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0]
    if not isinstance(first, dict):
        return ""
    delta = first.get("delta")
    if isinstance(delta, dict) and isinstance(delta.get("content"), str):
        return sanitize_text(str(delta["content"]), max_chars)
    return ""


# ===== COPY OF NEW extract_openai_delta_text (FIXED) =====
def extract_openai_delta_text_NEW(data, max_chars=80000):
    """NEW version — does NOT call sanitize_text, preserves spaces."""
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0]
    if not isinstance(first, dict):
        return ""
    delta = first.get("delta")
    if isinstance(delta, dict):
        content = delta.get("content")
        if isinstance(content, str):
            cleaned = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", content)
            return cleaned[:max_chars] if len(cleaned) > max_chars else cleaned
    return ""


# ===== Simulate LLM streaming =====
# This is how OpenAI-compatible APIs send tokens — each with a leading space
SIMULATED_SSE_CHUNKS = [
    '{"choices":[{"delta":{"content":"**"}}]}',
    '{"choices":[{"delta":{"content":"Thought"}}]}',
    '{"choices":[{"delta":{"content":":**"}}]}',
    '{"choices":[{"delta":{"content":" 1"}}]}',
    '{"choices":[{"delta":{"content":"."}}]}',
    '{"choices":[{"delta":{"content":" INTAKE"}}]}',
    '{"choices":[{"delta":{"content":":"}}]}',
    '{"choices":[{"delta":{"content":" User"}}]}',
    '{"choices":[{"delta":{"content":" is"}}]}',
    '{"choices":[{"delta":{"content":" expressing"}}]}',
    '{"choices":[{"delta":{"content":" feelings"}}]}',
    '{"choices":[{"delta":{"content":"\\n"}}]}',
    '{"choices":[{"delta":{"content":"\\n"}}]}',
    '{"choices":[{"delta":{"content":"**"}}]}',
    '{"choices":[{"delta":{"content":"Balanced"}}]}',
    '{"choices":[{"delta":{"content":" Reframe"}}]}',
    '{"choices":[{"delta":{"content":":**"}}]}',
    '{"choices":[{"delta":{"content":" "}}]}',
    '{"choices":[{"delta":{"content":"أنا"}}]}',
    '{"choices":[{"delta":{"content":" فاهم"}}]}',
    '{"choices":[{"delta":{"content":" إنك"}}]}',
    '{"choices":[{"delta":{"content":" بتحس"}}]}',
    '{"choices":[{"delta":{"content":" بضغط"}}]}',
    '{"choices":[{"delta":{"content":" كبير"}}]}',
    '{"choices":[{"delta":{"content":"."}}]}',
]

print("=" * 70)
print("TEST 1: OLD extractor (BUGGY — uses sanitize_text)")
print("=" * 70)
old_result = ""
for chunk_json in SIMULATED_SSE_CHUNKS:
    data = json.loads(chunk_json)
    text = extract_openai_text_OLD(data)
    old_result += text

print(f"Result: {old_result}")
print(f"Has spaces: {'YES ✅' if ' ' in old_result else 'NO ❌'}")

print()
print("=" * 70)
print("TEST 2: NEW extractor (FIXED — preserves spaces)")
print("=" * 70)
new_result = ""
for chunk_json in SIMULATED_SSE_CHUNKS:
    data = json.loads(chunk_json)
    text = extract_openai_delta_text_NEW(data)
    new_result += text

print(f"Result: {new_result}")
print(f"Has spaces: {'YES ✅' if ' ' in new_result else 'NO ❌'}")

print()
print("=" * 70)
print("TOKEN-BY-TOKEN COMPARISON")
print("=" * 70)
print(f"{'Token':<20} {'OLD':<20} {'NEW':<20}")
print("-" * 60)
for chunk_json in SIMULATED_SSE_CHUNKS:
    data = json.loads(chunk_json)
    original_content = data["choices"][0]["delta"]["content"]
    old_text = extract_openai_text_OLD(data)
    new_text = extract_openai_delta_text_NEW(data)
    
    old_display = repr(old_text)
    new_display = repr(new_text)
    orig_display = repr(original_content)
    
    marker = " ⚠️ SPACE STRIPPED!" if old_text != new_text else ""
    print(f"{orig_display:<20} {old_display:<20} {new_display:<20}{marker}")


# ===== Also test Arabic-only tokens =====
print()
print("=" * 70)
print("TEST 3: Arabic tokens with spaces")
print("=" * 70)
arabic_chunks = [
    '{"choices":[{"delta":{"content":" أنا"}}]}',
    '{"choices":[{"delta":{"content":" قلقان"}}]}',
    '{"choices":[{"delta":{"content":" على"}}]}',
    '{"choices":[{"delta":{"content":" أمانك"}}]}',
    '{"choices":[{"delta":{"content":"."}}]}',
]

old_arabic = ""
new_arabic = ""
for chunk_json in arabic_chunks:
    data = json.loads(chunk_json)
    old_arabic += extract_openai_text_OLD(data)
    new_arabic += extract_openai_delta_text_NEW(data)

print(f"OLD: {old_arabic}")
print(f"NEW: {new_arabic}")
print(f"OLD has spaces: {'YES ✅' if ' ' in old_arabic else 'NO ❌'}")
print(f"NEW has spaces: {'YES ✅' if ' ' in new_arabic else 'NO ❌'}")
