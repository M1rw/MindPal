"""How well and how fast MindPal reads images: the real vision pipeline on fixtures.

    python scripts/eval/files_eval.py
    python scripts/eval/files_eval.py --only receipt,arabic

Each fixture in tests/fixtures/files/images has its expected kind and text
(truth.json). An image goes through DigestService exactly as an upload does
(the vision fallback list, the same prompt), with the digest cache and the
daily allowance out of the way. Reported per image: kind right or not,
character error rate of the text (0 = perfect; whitespace and punctuation
ignored, Arabic letters normalised), and time. Scanned PDF pages take the same
path as images. PDF text layers are read in the browser and are not measured
here (a 9-page text PDF reads in under a second there).

Writes artifacts/evals/files-<time>.json.
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
import time
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
FIXTURES = ROOT / "tests" / "fixtures" / "files" / "images"


def _norm(text: str) -> str:
    text = unicodedata.normalize("NFKC", text or "").lower()
    text = re.sub(r"[ً-ْـ]", "", text)  # Arabic diacritics and tatweel
    text = text.replace("أ", "ا").replace("إ", "ا").replace("آ", "ا").replace("ى", "ي").replace("ة", "ه")
    return re.sub(r"[\W_]+", "", text)


def char_error_rate(expected: str, got: str) -> float:
    a, b = _norm(expected), _norm(got)
    if not a:
        return 0.0 if not b else 1.0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        for j, cb in enumerate(b, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb))
        prev = cur
    return min(1.0, prev[-1] / len(a))


class _NoLimits:
    def take(self, *args, **kwargs) -> None:
        return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", default="", help="comma-separated fixture id prefixes")
    args = parser.parse_args()

    from backend.domain.files import digest as digest_mod
    from backend.domain.files.digest import DigestService
    from backend.infra.llm import vision
    from backend.infra.store.store import InMemoryStore

    truth = json.loads((FIXTURES / "truth.json").read_text(encoding="utf-8"))
    ids = list(truth)
    if args.only:
        prefixes = tuple(p.strip() for p in args.only.split(",") if p.strip())
        ids = [i for i in ids if i.startswith(prefixes)]

    readers: list = []

    def reader(images, instruction, *, max_tokens=4096):
        reading = vision.read_images(images, instruction, max_tokens=max_tokens)
        readers.append(f"{reading.provider}:{reading.model}")
        return reading

    service = DigestService(store=InMemoryStore(), allowance=_NoLimits(), reader=reader)
    digest_mod.vision_available = lambda: True
    rows = []
    for fixture in ids:
        data = (FIXTURES / f"{fixture}.png").read_bytes()
        started = time.monotonic()
        try:
            digest = service.digest_image(data, "image/png", subject=f"eval:{time.time()}", signed_in=True, name=fixture)
        except Exception as exc:  # the report shows what failed
            rows.append({"id": fixture, "error": f"{type(exc).__name__}: {exc}"[:200]})
            print(f"  {fixture}: ERROR {exc}", flush=True)
            continue
        seconds = round(time.monotonic() - started, 2)
        page = digest.pages[0]
        expected = truth[fixture]
        cer = char_error_rate(expected["text"], page.text) if expected["text"] else None
        row = {
            "id": fixture,
            "kind_expected": expected["kind"],
            "kind_got": digest.content,
            "kind_ok": digest.content == expected["kind"] or (expected["kind"] == "text" and digest.content == "mixed"),
            "cer": None if cer is None else round(cer, 3),
            "seconds": seconds,
            "reader": readers[-1] if readers else "",
            "text": page.text[:300],
            "description": page.description[:200],
        }
        rows.append(row)
        print(f"  {fixture}: kind {row['kind_got']} ({'ok' if row['kind_ok'] else 'WRONG'}), cer {row['cer']}, {seconds}s via {row['reader']}", flush=True)

    ok = [r for r in rows if "error" not in r]
    cers = [r["cer"] for r in ok if r["cer"] is not None]
    summary = {
        "images": len(rows),
        "errors": len(rows) - len(ok),
        "kind_accuracy": round(sum(r["kind_ok"] for r in ok) / len(ok), 2) if ok else None,
        "mean_cer": round(statistics.mean(cers), 3) if cers else None,
        "p50_seconds": round(statistics.median([r["seconds"] for r in ok]), 2) if ok else None,
    }
    out = ROOT / "artifacts" / "evals" / f"files-{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"summary": summary, "rows": rows}, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"summary: {summary} -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
