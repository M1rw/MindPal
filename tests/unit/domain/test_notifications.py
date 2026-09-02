def test_notification_settings_endpoints(auth_client):
    res = auth_client.get("/api/notifications/settings")
    assert res.status_code == 200
    data = res.json()
    assert "response_complete" in data
    assert "streak_reminders" in data
    assert "mood_checkin" in data

    put_res = auth_client.put(
        "/api/notifications/settings",
        json={"response_complete": "in_app", "streak_reminders": "in_app", "mood_checkin": "off"},
    )
    assert put_res.status_code == 200
    assert put_res.json()["streak_reminders"] == "in_app"
