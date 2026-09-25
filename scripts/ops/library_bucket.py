"""Create the private library bucket (idempotent) and prove it works end to end.

    python scripts/ops/library_bucket.py            # ensure the bucket + round trip
    python scripts/ops/library_bucket.py --check    # round trip only

Uses SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, like the document store. The
round trip signs an upload, uploads a few bytes the way a browser does, checks
the stored size, signs a download, reads it back, and deletes it again, all
under a "_selftest/" prefix no account can have.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="skip creating the bucket")
    args = parser.parse_args()

    from backend.configs.runtime import api_limits_config
    from backend.configs.settings import get_settings
    from backend.infra.blob.blob import BUCKET, SupabaseBlobStore

    url, key = get_settings().supabase_settings()
    if not url or not key:
        print("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.")
        return 2
    store = SupabaseBlobStore(url, key)
    limits = api_limits_config()["files"]["account"]
    if not args.check:
        largest = max(int(limits["max_pdf_bytes"]), int(limits["max_image_bytes"]))
        created = store.ensure_bucket(file_size_limit=largest)
        print(f"bucket {BUCKET}: {'created' if created else 'already there'} (private, files up to {largest // 1_000_000} MB)")

    path = f"_selftest/{int(time.time())}/probe.txt"
    body = b"mindpal library self-test"
    upload = store.signed_upload_url(path, "text/plain")
    put = httpx.put(upload, content=body, headers={"Content-Type": "text/plain", "x-upsert": "true"}, timeout=20)
    print(f"upload via signed link: {put.status_code}")
    stat = store.stat(path)
    print(f"stored size: {stat.size if stat else None} (sent {len(body)})")
    download = store.signed_download_url(path, seconds=60)
    got = httpx.get(download, timeout=20)
    print(f"download via signed link: {got.status_code}, matches: {got.content == body}")
    unsigned = httpx.get(f"{url.rstrip('/')}/storage/v1/object/public/{BUCKET}/{path}", timeout=20)
    print(f"public read refused: {unsigned.status_code >= 400}")
    removed = store.delete_paths([o.path for o in store.list_prefix(path.rsplit('/', 1)[0] + '/')])
    print(f"deleted: {removed}, left: {len(store.list_prefix(path.rsplit('/', 1)[0] + '/'))}")
    ok = put.status_code == 200 and stat and stat.size == len(body) and got.content == body and unsigned.status_code >= 400
    print("OK" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
