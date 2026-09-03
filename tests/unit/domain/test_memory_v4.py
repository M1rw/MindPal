def test_memory_v4_endpoints(auth_client):
    # GET /api/memory/summary
    response = auth_client.get("/api/memory/summary")
    assert response.status_code == 200
    data = response.json()
    assert "summary_text" in data
    assert "is_enabled" in data

    # PUT /api/memory/summary
    edit_payload = {"instruction": "Always speak gently and remember my exam stress."}
    response = auth_client.put("/api/memory/summary", json=edit_payload)
    assert response.status_code == 200

    # GET /api/memory/nodes
    response = auth_client.get("/api/memory/nodes")
    assert response.status_code == 200
    nodes = response.json()
    assert isinstance(nodes, list)

    # GET /api/memory/provenance/res_123
    response = auth_client.get("/api/memory/provenance/res_123")
    assert response.status_code == 200
    prov = response.json()
    assert prov["response_id"] == "res_123"

    # PATCH /api/memory/settings
    response = auth_client.patch("/api/memory/settings", json={"is_enabled": False})
    assert response.status_code == 200
    assert response.json()["is_enabled"] is False


def test_memory_v4_long_summary_untruncated(auth_client):
    long_narrative = (
        "## Overview\n\n"
        "The user is a college student in his final stretch, with three years left to graduate. "
        "He is currently overwhelmed with multiple projects, feeling stuck and unproductive, "
        "but he remains determined to build better coping strategies and balance his academic workload."
    )
    assert len(long_narrative) > 200

    edit_payload = {"instruction": long_narrative}
    response = auth_client.put("/api/memory/summary", json=edit_payload)
    assert response.status_code == 200
    data = response.json()
    assert not data["summary_text"].endswith("…")
    assert not data["summary_text"].endswith("...")
    assert len(data["summary_text"]) > 200

    response = auth_client.get("/api/memory/summary")
    assert response.status_code == 200
    get_data = response.json()
    assert not get_data["summary_text"].endswith("…")
    assert not get_data["summary_text"].endswith("...")
    assert len(get_data["summary_text"]) > 200
