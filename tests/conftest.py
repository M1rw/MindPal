# tests/conftest.py — platform rebuild. Legacy suite is paused until pal-7.

from __future__ import annotations

from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient

from backend.main import create_app


@pytest.fixture
def app():
    return create_app(serve_frontend=False)


@pytest.fixture
def client(app) -> Generator[TestClient, None, None]:
    with TestClient(app) as test_client:
        yield test_client
