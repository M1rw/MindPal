#!/usr/bin/env python
"""Push environment variables from .env.vercel or .env.local to Vercel via REST API.

Usage:
    python scripts/ops/push_env_to_vercel.py [VERCEL_TOKEN]

If VERCEL_TOKEN is not provided as an argument, it reads os.environ.get("VERCEL_TOKEN").
If no token is present, it prints instructions on how to obtain one or how to import
.env.vercel directly in the Vercel Dashboard.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
import httpx

REPO_ROOT = Path(__file__).resolve().parents[2]
PROJECT_ID = "prj_0d0bg72zGTnGMNWE4heY4dXBXZMZ"
TEAM_ID = "team_njzfMs5xr8KVtMuoFWo0tgGU"
ENV_FILE = REPO_ROOT / ".env.vercel"


def load_env_vars() -> dict[str, str]:
    if not ENV_FILE.exists():
        print(f"Error: {ENV_FILE} not found. Run scratch/generate_vercel_env.py first.")
        sys.exit(1)

    result: dict[str, str] = {}
    for line in ENV_FILE.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip()
        val = val.strip()
        if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
            val = val[1:-1]
        result[key] = val
    return result


def main() -> int:
    token = sys.argv[1].strip() if len(sys.argv) > 1 else os.environ.get("VERCEL_TOKEN", "").strip()
    env_vars = load_env_vars()

    print(f"Loaded {len(env_vars)} environment variables from {ENV_FILE.name}.")

    if not token:
        print("\nNo VERCEL_TOKEN provided.")
        print("\nYou have two quick options to push these variables to Vercel:")
        print("\nOption 1: One-Click Web Import (Fastest & Easiest)")
        print("1. Open: https://vercel.com/miljtes-projects/mindpal-demo/settings/environment-variables")
        print("2. Click 'Import .env'")
        print(f"3. Select or paste the contents of: {ENV_FILE}")
        print("4. Select [x] Production, [x] Preview, [x] Development and click Save.")
        print("\nOption 2: CLI / API Push")
        print("1. Create a personal token at: https://vercel.com/account/tokens")
        print("2. Run: python scripts/ops/push_env_to_vercel.py <YOUR_VERCEL_TOKEN>")
        return 0

    print(f"Authenticating with Vercel API for project {PROJECT_ID}...")
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    # Fetch existing env vars to update or create
    list_url = f"https://api.vercel.com/v9/projects/{PROJECT_ID}/env?teamId={TEAM_ID}"
    resp = httpx.get(list_url, headers=headers, timeout=20)
    if resp.status_code != 200:
        print(f"Failed to fetch existing env vars: HTTP {resp.status_code} - {resp.text}")
        return 1

    existing = {item["key"]: item["id"] for item in resp.json().get("envs", [])}
    print(f"Found {len(existing)} existing variables on Vercel.")

    success_count = 0
    fail_count = 0

    for key, val in env_vars.items():
        payload = {
            "key": key,
            "value": val,
            "type": "encrypted" if any(s in key.lower() for s in ["key", "secret", "token", "credentials"]) else "plain",
            "target": ["production", "preview", "development"],
        }
        if key in existing:
            env_id = existing[key]
            update_url = f"https://api.vercel.com/v9/projects/{PROJECT_ID}/env/{env_id}?teamId={TEAM_ID}"
            r = httpx.patch(update_url, headers=headers, json={"value": val, "target": ["production", "preview", "development"]}, timeout=15)
        else:
            create_url = f"https://api.vercel.com/v10/projects/{PROJECT_ID}/env?teamId={TEAM_ID}"
            r = httpx.post(create_url, headers=headers, json=payload, timeout=15)

        if r.status_code in (200, 201):
            success_count += 1
            print(f"  + {key} (synced)")
        else:
            fail_count += 1
            print(f"  x {key} (failed: {r.status_code} {r.text[:100]})")

    print(f"\nDone: {success_count} synced, {fail_count} failed.")
    return 0 if fail_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
