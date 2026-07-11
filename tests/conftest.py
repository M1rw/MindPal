from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def isolate_tests_from_workspace_dotenv(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Prevent developer secrets and host policy from changing deterministic tests."""
    monkeypatch.chdir(tmp_path)
