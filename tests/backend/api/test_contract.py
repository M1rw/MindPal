from backend.core.contract import iter_operations
from backend.core.errors import AppError
from backend.http.drift import drift_report
from backend.http.errors import status_for_code
from backend.main import create_app


def test_every_operation_has_x_mindpal_and_operation_id():
    ops = list(iter_operations())
    assert ops
    assert all(op["operation_id"] and op["x_mindpal"]["owner"] for op in ops)
    assert not any("/brain" in op["path"] for op in ops)


def test_fastapi_matches_openapi():
    report = drift_report(create_app(serve_frontend=False))
    assert report["ok"], report


def test_live_health_and_changelog():
    from fastapi.testclient import TestClient

    client = TestClient(create_app(serve_frontend=False))
    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.json()["status"] == "rebuilding"
    changelog = client.get("/api/release/changelog")
    assert changelog.status_code == 200
    assert changelog.json()["current_version"] == "5.0.0"


def test_bootstrap_injection_in_index():
    """Pattern B: server injects __MINDPAL_BOOTSTRAP__ JSON block into GET /."""
    from fastapi.testclient import TestClient

    client = TestClient(create_app(serve_frontend=True))
    res = client.get("/")
    # The server either serves the React shell or a 404 placeholder when
    # index.html is absent in the test environment — either way the bootstrap
    # node must never be absent when the HTML shell is served.
    if res.status_code == 200 and "<html" in res.text:
        assert "__MINDPAL_BOOTSTRAP__" in res.text, "Bootstrap node missing from HTML shell"
        assert "FIREBASE_CREDENTIALS_JSON" not in res.text
        assert "private_key" not in res.text


def test_chat_stream_mounted():
    from fastapi.testclient import TestClient

    client = TestClient(create_app(serve_frontend=False))
    res = client.post("/api/chat/stream", json={"message": "hello"})
    assert res.status_code == 200
    assert "text/event-stream" in res.headers["content-type"]


def test_error_catalog_status():
    assert status_for_code("unauthenticated") == 401
    err = AppError("quota_exceeded", "wait")
    assert err.code == "quota_exceeded"
