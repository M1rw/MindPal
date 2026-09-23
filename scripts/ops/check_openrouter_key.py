#!/usr/bin/env python
"""Report what an OpenRouter key is actually allowed to do.

A 429 on the very first request is not usage exhaustion - it means the account's
limit is already at or below zero. OpenRouter gates free models on the account's
lifetime credit purchase, so a key that has never had credits added gets a very
small daily allowance regardless of how little it has been used.

`GET /api/v1/key` is free and read-only. It answers in one call what a completion
request can only hint at through an error body.

Usage:
    python scripts/ops/check_openrouter_key.py

Reads OPENROUTER_API_KEY from the environment, then .env.local, then .env.
The key itself is never printed - only its prefix length and its limits.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Optional

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # pragma: no cover
        pass


def load_key() -> Optional[str]:
    value = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if value:
        return value
    for filename in (".env.local", ".env"):
        path = REPO_ROOT / filename
        if not path.exists():
            continue
        for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, _, val = line.partition("=")
            if name.strip() != "OPENROUTER_API_KEY":
                continue
            cleaned = val.strip().strip('"').strip("'")
            if cleaned:
                print(f"  (key loaded from {filename})")
                return cleaned
    return None


def main() -> int:
    import httpx

    print("OpenRouter key check")
    key = load_key()
    if not key:
        print("  OPENROUTER_API_KEY not found in env, .env.local, or .env.")
        return 2
    print(f"  key shape: {len(key)} chars, starts {key[:7]}...")

    try:
        response = httpx.get(
            "https://openrouter.ai/api/v1/key",
            headers={"Authorization": f"Bearer {key}"},
            timeout=20,
        )
    except Exception as exc:  # noqa: BLE001 - diagnostic
        print(f"  transport failed: {type(exc).__name__}: {exc}")
        return 1

    print(f"  status: {response.status_code}")
    if response.status_code == 401:
        print()
        print("  UNAUTHORIZED. The key is invalid, revoked, or from another account.")
        print("  If you rotated it after pasting it in chat, .env.local still has the old one.")
        return 1
    if response.status_code >= 400:
        print(f"  body: {response.text[:300]}")
        return 1

    data = (response.json() or {}).get("data") or {}
    usage = data.get("usage")
    limit = data.get("limit")
    remaining = data.get("limit_remaining")
    is_free_tier = data.get("is_free_tier")
    rate = data.get("rate_limit") or {}

    print()
    print(f"  label            : {data.get('label') or '(none)'}")
    print(f"  is_free_tier     : {is_free_tier}")
    print(f"  usage (credits)  : {usage}")
    print(f"  limit            : {limit if limit is not None else 'unlimited'}")
    print(f"  limit_remaining  : {remaining if remaining is not None else 'n/a'}")
    if rate:
        print(f"  rate_limit       : {json.dumps(rate)}")

    print()
    print("Reading")
    if limit is not None and remaining is not None and remaining <= 0:
        print("  Credit limit reached. Free models stop serving once the account")
        print("  allowance is spent, even though the models themselves cost nothing.")
    elif is_free_tier:
        print("  This is a free-tier key. OpenRouter scales the free-model daily")
        print("  allowance with lifetime credits purchased on the account - a key")
        print("  that has never had credits added gets a small daily cap, which is")
        print("  why a 429 can land on the first request of the day.")
        print()
        print("  Options, cheapest first:")
        print("    1. Add a small credit balance. It raises the FREE-model daily cap;")
        print("       :free models still cost nothing per token.")
        print("    2. Use Groq instead - GROQ_API_KEY is already set in .env.local:")
        print("         MINDPAL_CHAT_PROVIDER=groq")
        print("         MINDPAL_JSON_PROVIDER=groq")
        print("       Groq is also far faster, which matters for the 600ms mic gate.")
        print("    3. Point the paid path at a cheap model rather than a free one.")
    else:
        print("  The key has headroom. A 429 from a specific model is that model's")
        print("  own limit, not the account's - try another id from")
        print("  scripts/eval/rank_openrouter_free.py.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
