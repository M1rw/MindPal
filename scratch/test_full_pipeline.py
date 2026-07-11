"""Full end-to-end test of the streaming pipeline: backend + frontend parsing."""
import json
import re
import sys

# ============================================================
# 1. BACKEND TEST: Provider → LLMService → chat_stream_router
# ============================================================

print("=" * 70)
print("1. BACKEND: Testing extract_openai_delta_text vs extract_openai_text")
print("=" * 70)

# Import the actual backend code
try:
    from backend.providers._shared import extract_openai_delta_text, extract_openai_text
    print("  [OK] Imported backend providers successfully")
except Exception as e:
    print(f"  [FAIL] Import error: {e}")
    sys.exit(1)

# Simulate SSE chunks exactly as an OpenAI-compat LLM sends them
test_chunks = [
    {"choices": [{"delta": {"content": "**"}}]},
    {"choices": [{"delta": {"content": "Thought"}}]},
    {"choices": [{"delta": {"content": ":**"}}]},
    {"choices": [{"delta": {"content": " 1"}}]},
    {"choices": [{"delta": {"content": "."}}]},
    {"choices": [{"delta": {"content": " INTAKE"}}]},
    {"choices": [{"delta": {"content": ":"}}]},
    {"choices": [{"delta": {"content": " User"}}]},
    {"choices": [{"delta": {"content": " feels"}}]},
    {"choices": [{"delta": {"content": " rejected"}}]},
    {"choices": [{"delta": {"content": "\n\n"}}]},
    {"choices": [{"delta": {"content": "**"}}]},
    {"choices": [{"delta": {"content": "Balanced"}}]},
    {"choices": [{"delta": {"content": " Reframe"}}]},
    {"choices": [{"delta": {"content": ":**"}}]},
    {"choices": [{"delta": {"content": " "}}]},
    # Arabic tokens
    {"choices": [{"delta": {"content": "\u0623\u0646\u0627"}}]},  # أنا
    {"choices": [{"delta": {"content": " \u0641\u0627\u0647\u0645"}}]},  # فاهم
    {"choices": [{"delta": {"content": " \u0625\u0646\u0643"}}]},  # إنك
    {"choices": [{"delta": {"content": " \u0628\u062a\u062d\u0633"}}]},  # بتحس
    {"choices": [{"delta": {"content": " \u0628\u0636\u063a\u0637"}}]},  # بضغط
    {"choices": [{"delta": {"content": "."}}]},
]

old_result = ""
new_result = ""
for chunk in test_chunks:
    old_result += extract_openai_text(chunk)
    new_result += extract_openai_delta_text(chunk)

print("\n  OLD extractor (extract_openai_text):")
print(f"    Result: {old_result}")
print(f"    Has spaces: {'YES' if ' ' in old_result else 'NO -- BUG!'}")

print("\n  NEW extractor (extract_openai_delta_text):")
print(f"    Result: {new_result}")
print(f"    Has spaces: {'YES' if ' ' in new_result else 'NO -- BUG!'}")

# Verify the new extractor preserves spaces
assert " " in new_result, "FAIL: New extractor still strips spaces!"
assert "Balanced Reframe" in new_result, "FAIL: New extractor lost space in 'Balanced Reframe'!"
print("\n  [PASS] Backend delta extractor preserves all spaces")

# ============================================================
# 2. BACKEND: Test iter_sse_text default extractor
# ============================================================
print("\n" + "=" * 70)
print("2. BACKEND: Verify iter_sse_text uses extract_openai_delta_text")
print("=" * 70)

import inspect  # noqa: E402
from backend.providers._shared import iter_sse_text  # noqa: E402

source = inspect.getsource(iter_sse_text)
if "extract_openai_delta_text" in source:
    print("  [PASS] iter_sse_text defaults to extract_openai_delta_text")
else:
    print("  [FAIL] iter_sse_text still uses old extract_openai_text!")

# ============================================================
# 3. BACKEND: Test Gemini delta extractor
# ============================================================
print("\n" + "=" * 70)
print("3. BACKEND: Testing Gemini _extract_delta_text")
print("=" * 70)

try:
    from backend.providers.gemini_provider import _extract_delta_text as gemini_extract_delta
    
    gemini_chunk = {
        "candidates": [{
            "content": {
                "parts": [{"text": " hello world"}]
            }
        }]
    }
    result = gemini_extract_delta(gemini_chunk)
    assert result == " hello world", f"FAIL: Got [{result}] expected [ hello world]"
    print("  [PASS] Gemini _extract_delta_text preserves leading spaces")
except ImportError as e:
    print(f"  [SKIP] Cannot import Gemini delta: {e}")
except Exception as e:
    print(f"  [FAIL] {e}")

# ============================================================
# 4. BACKEND: Verify Gemini generate_stream uses _extract_delta_text
# ============================================================
print("\n" + "=" * 70)
print("4. BACKEND: Verify Gemini generate_stream uses _extract_delta_text")
print("=" * 70)

try:
    from backend.providers.gemini_provider import GeminiProvider
    source = inspect.getsource(GeminiProvider.generate_stream)
    if "_extract_delta_text" in source:
        print("  [PASS] Gemini generate_stream uses _extract_delta_text")
    else:
        print("  [FAIL] Gemini generate_stream still uses _extract_text!")
except Exception as e:
    print(f"  [FAIL] {e}")

# ============================================================
# 5. BACKEND: Simulate full stream_generator pipeline
# ============================================================
print("\n" + "=" * 70)
print("5. BACKEND: Simulate chat_stream_router pipeline")
print("=" * 70)

# This simulates what chat_stream_router.py does:
# async for chunk in services.llm.generate_stream(llm_request):
#     full_text.append(chunk)
#     yield f"data: {json.dumps({'text': chunk})}\n\n"

sse_output_lines = []
for chunk in test_chunks:
    text = extract_openai_delta_text(chunk)
    if text:
        sse_line = f"data: {json.dumps({'text': text})}"
        sse_output_lines.append(sse_line)

print(f"  Generated {len(sse_output_lines)} SSE lines")

# ============================================================
# 6. FRONTEND: Simulate SSE parsing (api.js sendChatMessageStream)
# ============================================================
print("\n" + "=" * 70)
print("6. FRONTEND: Simulate SSE parsing (api.js)")
print("=" * 70)

# This simulates what api.js does:
# const dataStr = line.slice(6).trim();
# const data = JSON.parse(dataStr);
# if (data.text !== undefined) onChunk(data.text);
# And app.js: streamResponseStr += chunkText;

stream_response_str = ""
for sse_line in sse_output_lines:
    data_str = sse_line[6:].strip()  # line.slice(6).trim()
    data = json.loads(data_str)
    if "text" in data:
        stream_response_str += data["text"]

print(f"  Reconstructed stream: {stream_response_str[:100]}...")
print(f"  Has spaces: {'YES' if ' ' in stream_response_str else 'NO -- BUG!'}")
assert " " in stream_response_str, "FAIL: Frontend reconstruction has no spaces!"
print("  [PASS] Frontend SSE parsing preserves spaces")

# ============================================================
# 7. FRONTEND: Test processStructuredResponse parsing
# ============================================================
print("\n" + "=" * 70)
print("7. FRONTEND: Test delimiter detection (regex from app.js)")
print("=" * 70)

# From app.js line 901-902:
delimiter_re1 = re.compile(r'\*{2}\s*(?:Response|Balanced\s*Reframe)\s*:?\s*\*{2}', re.I)
delimiter_re2 = re.compile(r'(?:\n|^)\s*(?:Response|Balanced\s*Reframe)\s*:\s*', re.I)

has_delimiter = bool(delimiter_re1.search(stream_response_str)) or bool(delimiter_re2.search(stream_response_str))
print(f"  Stream text contains delimiter: {has_delimiter}")

if has_delimiter:
    print("  [PASS] Delimiter found — thought timing will work correctly")
else:
    print("  [FAIL] Delimiter NOT found — timing will be wrong!")

# Test with no-spaces version too (belt and suspenders)
no_spaces = stream_response_str.replace(" ", "")
has_delimiter_nospc = bool(delimiter_re1.search(no_spaces)) or bool(delimiter_re2.search(no_spaces))
print(f"  No-spaces version contains delimiter: {has_delimiter_nospc}")
if has_delimiter_nospc:
    print("  [PASS] Delimiter regex also works without spaces (\\s* fix)")
else:
    print("  [WARN] Delimiter regex doesn't match no-spaces — depends on backend fix")

# ============================================================
# 8. VERIFY: Check which provider is being used in production
# ============================================================
print("\n" + "=" * 70)
print("8. CHECK: Which provider is used in production?")
print("=" * 70)

try:
    from backend.core.config import get_settings
    settings = get_settings()
    
    providers_info = []
    
    # Check Cloudflare
    cf_token = getattr(settings, "CLOUDFLARE_AIG_TOKEN", None) or getattr(settings, "CLOUDFLARE_API_TOKEN", None)
    if cf_token:
        providers_info.append("Cloudflare (configured)")
    
    # Check Gemini
    gemini_key = getattr(settings, "GEMINI_API_KEY", None)
    if gemini_key:
        providers_info.append("Gemini (configured)")
    
    # Check OpenRouter
    or_key = getattr(settings, "OPENROUTER_API_KEY", None)
    if or_key:
        providers_info.append("OpenRouter (configured)")
    
    # Check Groq
    groq_key = getattr(settings, "GROQ_API_KEY", None)
    if groq_key:
        providers_info.append("Groq (configured)")
    
    if providers_info:
        for p in providers_info:
            print(f"  - {p}")
    else:
        print("  No providers configured locally (expected — env vars are on Vercel)")
        
except Exception as e:
    print(f"  Cannot check settings locally: {e}")
    print("  (Expected — env vars are on Vercel)")

# ============================================================
# 9. VERIFY: Check ALL providers use correct stream extractor
# ============================================================
print("\n" + "=" * 70)
print("9. CHECK: All providers use correct stream extractor")
print("=" * 70)

provider_files = {
    "Cloudflare": "backend/providers/cloudflare_provider.py",
    "OpenRouter": "backend/providers/openrouter_provider.py",
    "Groq": "backend/providers/groq_provider.py",
    "Gemini": "backend/providers/gemini_provider.py",
}

import os  # noqa: E402
for name, path in provider_files.items():
    full_path = os.path.join("e:/Synthos/MindPal", path)
    with open(full_path, "r", encoding="utf-8") as f:
        content = f.read()
    
    # Check if generate_stream uses iter_sse_text
    if "iter_sse_text" in content:
        # Find what extractor is passed
        import re as re2
        match = re2.search(r'iter_sse_text\(response(?:,\s*([^)]+))?\)', content)
        if match:
            extractor = match.group(1)
            if extractor:
                extractor = extractor.strip()
                if "extract_text" in extractor and "delta" not in extractor:
                    # Old non-delta extractor — check if it calls sanitize_text
                    print(f"  [{name}] Uses iter_sse_text with custom extractor: {extractor}")
                    if name == "Gemini" and "_extract_delta_text" in extractor:
                        print("    [PASS] Uses streaming-safe _extract_delta_text")
                    elif name == "Gemini":
                        print("    [FAIL] Still uses old _extract_text!")
                else:
                    print(f"  [{name}] Uses iter_sse_text with: {extractor} — OK")
            else:
                print(f"  [{name}] Uses iter_sse_text with DEFAULT (extract_openai_delta_text) — OK")
    else:
        print(f"  [{name}] Does NOT use iter_sse_text — needs manual check")

# ============================================================
# FINAL SUMMARY
# ============================================================
print("\n" + "=" * 70)
print("FINAL SUMMARY")
print("=" * 70)

all_pass = True

# Check 1: Backend preserves spaces
if " " in new_result:
    print("  [PASS] Backend extract_openai_delta_text preserves spaces")
else:
    print("  [FAIL] Backend still strips spaces!")
    all_pass = False

# Check 2: Frontend reconstruction preserves spaces
if " " in stream_response_str:
    print("  [PASS] Full pipeline (backend→SSE→frontend) preserves spaces")
else:
    print("  [FAIL] Full pipeline strips spaces!")
    all_pass = False

# Check 3: Delimiter detection works
if has_delimiter:
    print("  [PASS] Delimiter detection works for timing")
else:
    print("  [FAIL] Delimiter detection broken!")
    all_pass = False

if all_pass:
    print("\n  ALL TESTS PASSED ✓")
    print("  If the deployed app still shows no spaces, the deployment")
    print("  hasn't picked up the latest commit yet.")
else:
    print("\n  SOME TESTS FAILED!")
