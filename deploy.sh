#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

python scripts/verify_backend_v2.py "${@}"

if ! command -v vercel >/dev/null 2>&1; then
  echo "Vercel CLI is not installed. Verification passed; deployment was not started." >&2
  exit 2
fi

vercel deploy --prod
