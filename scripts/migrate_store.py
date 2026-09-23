"""Copy MindPal documents between storage providers, keeping document ids.

    python scripts/migrate_store.py --from firestore --to supabase --dry-run
    python scripts/migrate_store.py --from firestore --to supabase
    python scripts/migrate_store.py --from supabase --to firestore --collections memory_graphs,chat_sessions

The copy is idempotent (a re-run overwrites with the same data) and verifies
each collection's document count afterwards. Credentials come from the usual
environment variables; both providers must be configured.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Every collection the backend writes. Caches and probes are not user data.
USER_DATA_COLLECTIONS = (
    "user_profiles",
    "memory_graphs",
    "adaptive_profiles",
    "memory_journal",
    "memory_jobs",
    "chat_sessions",
    "session_telemetry",
    "user_presence",
    "changelog_dismissals",
    "user_quotas",
    "anon_rate_limits",
    "idempotency_records",
    "voice_minute_reservations",
    "voice_active_sessions",
    "voice_sessions",
    "voice_event_idempotency",
    "voice_telemetry",
    "voice_support_diagnostics",
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--from", dest="source", required=True, choices=["firestore", "supabase"])
    parser.add_argument("--to", dest="target", required=True, choices=["firestore", "supabase"])
    parser.add_argument("--collections", default=",".join(USER_DATA_COLLECTIONS))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    if args.source == args.target:
        parser.error("--from and --to must differ")

    from backend.infra.store.store import build_store

    source = build_store(args.source)
    target = build_store(args.target)
    failures = 0
    for collection in [name.strip() for name in args.collections.split(",") if name.strip()]:
        copied = 0
        for doc_id, data in source.iter_documents(collection):
            if not doc_id:
                continue
            if not args.dry_run:
                target.set_document(collection, doc_id, data)
            copied += 1
        verified = copied if args.dry_run else sum(1 for _ in target.iter_documents(collection))
        status = "ok" if verified >= copied else "MISMATCH"
        failures += status != "ok"
        print(f"{collection:28s} source={copied:6d} target={verified:6d} {status}{' (dry run)' if args.dry_run else ''}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
