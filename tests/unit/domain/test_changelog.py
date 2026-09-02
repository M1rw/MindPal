def test_changelog_system_major_filter_and_dismissal(client):
    # GET /api/features/changelog
    res = client.get("/api/features/changelog")
    assert res.status_code == 200
    data = res.json()
    assert "current_version" in data
    assert "entries" in data

    major_entries = [e for e in data["entries"] if e.get("major") is True]
    assert len(major_entries) > 0

    # Dismiss version 4.0.0
    dismiss_res = client.post("/api/features/changelog/dismiss", json={"version": "4.0.0"})
    assert dismiss_res.status_code == 200
    assert dismiss_res.json()["dismissed"] is True

    # Re-fetch and check dismissed list
    res_after = client.get("/api/features/changelog")
    assert "4.0.0" in res_after.json()["dismissed_versions"]
