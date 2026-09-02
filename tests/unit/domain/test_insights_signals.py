def test_mental_health_insights_and_improvement_signals(auth_client):
    # GET /api/user/insights
    res = auth_client.get("/api/user/insights")
    assert res.status_code == 200
    data = res.json()
    assert "reflection_summary" in data
    assert "phq9_history" in data
    assert "gad7_history" in data

    # POST /api/user/improvement-signals
    res_opt_in = auth_client.post("/api/user/improvement-signals", json={"opt_in": True})
    assert res_opt_in.status_code == 200
    assert res_opt_in.json()["opt_in"] is True

    res_opt_out = auth_client.post("/api/user/improvement-signals", json={"opt_in": False})
    assert res_opt_out.status_code == 200
    assert res_opt_out.json()["opt_in"] is False
