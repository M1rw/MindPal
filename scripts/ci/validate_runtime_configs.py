"""Validate every checked-in runtime JSON config against its JSON Schema."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.configs.runtime import validate_runtime_configs


if __name__ == "__main__":
    configs = validate_runtime_configs()
    print(f"Validated {len(configs)} runtime configuration files.")
