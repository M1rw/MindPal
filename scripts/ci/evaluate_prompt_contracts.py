"""Run deterministic regression checks for the versioned prompt registry."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.configs.prompts import PROMPT_REGISTRY, evaluate_prompt_versions

FIXTURE_PATH = ROOT / "data" / "prompt_fixtures" / "prompt_contracts.json"


def evaluate() -> int:
    with FIXTURE_PATH.open("r", encoding="utf-8") as fixture_file:
        payload = json.load(fixture_file)

    evaluate_prompt_versions()
    expected_version = str(payload.get("version") or "")
    failures: list[str] = []
    for fixture in payload.get("fixtures", []):
        key = str(fixture.get("key") or "")
        definition = PROMPT_REGISTRY.get(key)
        if definition is None:
            failures.append(f"{key}: missing registry entry")
            continue
        if definition.version != expected_version:
            failures.append(f"{key}: expected version {expected_version!r}")
        for fragment in fixture.get("required_fragments", []):
            if str(fragment) not in definition.text:
                failures.append(f"{key}: missing required fragment {fragment!r}")
        for field in ("channel", "output_format"):
            if str(fixture.get(field)) != str(getattr(definition, field)):
                failures.append(f"{key}: {field} metadata mismatch")

    if failures:
        raise SystemExit("Prompt contract failures:\n- " + "\n- ".join(failures))
    print(f"Validated {len(payload.get('fixtures', []))} prompt contract fixtures.")
    return 0


if __name__ == "__main__":
    raise SystemExit(evaluate())
