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
