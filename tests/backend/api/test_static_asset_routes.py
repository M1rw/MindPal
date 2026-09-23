# tests/backend/api/test_static_asset_routes.py - public asset routes serve one fixed file each
"""Regression for an unauthenticated arbitrary file read: the asset handlers
took their file path as a defaulted parameter, which FastAPI exposes as a
query parameter, so /robots.txt?path=<any file> returned that file."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.main import FRONTEND, create_app

ASSETS = ["favicon.ico", "site.webmanifest", "robots.txt", "sitemap.xml", "privacy.html", "terms.html"]


@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(create_app())


@pytest.mark.parametrize("name", ASSETS)
def test_request_cannot_choose_the_file_or_type(client: TestClient, tmp_path_factory, name: str) -> None:
    if not (FRONTEND / name).exists():
        pytest.skip(f"{name} not present")
    marker = tmp_path_factory.mktemp("outside") / "secret.txt"
    marker.write_text("AUDIT-MARKER-SECRET", encoding="utf-8")
    for probe in (str(marker), marker.as_posix(), "../../" + marker.name, "%2e%2e%2f" + marker.name):
        response = client.get(f"/{name}", params={"path": probe, "media": "text/plain"})
        assert "AUDIT-MARKER-SECRET" not in response.text
        assert response.content == (FRONTEND / name).read_bytes()


def test_normal_assets_keep_their_content_type(client: TestClient) -> None:
    if (FRONTEND / "robots.txt").exists():
        assert client.get("/robots.txt").headers["content-type"].startswith("text/plain")
    if (FRONTEND / "privacy.html").exists():
        assert client.get("/privacy.html").headers["content-type"].startswith("text/html")
