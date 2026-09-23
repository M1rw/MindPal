"""Validate the active Supabase migration contract without a live database."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / "supabase" / "migrations"
REQUIRED_MARKERS = {
    "mindpal_documents": r"create\s+table\s+if\s+not\s+exists\s+public\.mindpal_documents",
    "mindpal_update_document": r"create\s+or\s+replace\s+function\s+public\.mindpal_update_document",
    "service_role_grant": r"grant\s+execute\s+on\s+function\s+public\.mindpal_update_document",
}


def main() -> int:
    files = sorted(MIGRATIONS.glob("*.sql"))
    if not files:
        raise SystemExit("No Supabase migrations found")
    content = "\n".join(path.read_text(encoding="utf-8") for path in files)
    missing = [name for name, pattern in REQUIRED_MARKERS.items() if not re.search(pattern, content, re.IGNORECASE)]
    if missing:
        raise SystemExit("Missing Supabase migration markers: " + ", ".join(missing))
    if re.search(r"(service_role_key|api[_-]?key|private[_-]?key)\s*[:=]", content, re.IGNORECASE):
        raise SystemExit("Potential secret assignment found in Supabase migrations")
    print(f"Validated {len(files)} Supabase migration files.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
