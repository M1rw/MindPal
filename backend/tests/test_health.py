from fastapi.testclient import TestClient
from backend.main import app

client = TestClient(app)

def test_health_check_root():
    response = client.get("/")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert "project" in data

def test_health_check_api():
    response = client.get("/api/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"