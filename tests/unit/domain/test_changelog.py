AUTH = {"Authorization": "Bearer dev_changelog_reader"}


def test_changelog_system_major_filter_and_dismissal(client):
    # GET /api/release/changelog — the notes themselves are open to everyone.
    res = client.get("/api/release/changelog", headers=AUTH)
    assert res.status_code == 200
    data = res.json()
    assert "current_version" in data
    assert "entries" in data

    major_entries = [e for e in data["entries"] if e.get("major") is True]
    assert len(major_entries) > 0

    dismiss_res = client.post("/api/release/changelog", json={"version": "5.0.0"}, headers=AUTH)
    assert dismiss_res.status_code == 204

    res_after = client.get("/api/release/changelog", headers=AUTH)
    assert "5.0.0" in res_after.json()["dismissed_versions"]


def test_a_guest_reads_the_notes_but_has_no_dismissals(client):
    res = client.get("/api/release/changelog")
    assert res.status_code == 200
    assert res.json()["entries"]
    assert res.json()["dismissed_versions"] == []


def test_one_visitor_cannot_dismiss_a_release_for_everyone(client):
    """Dismissals used to land in a shared "anonymous" document.

    One signed-out visitor hiding a release therefore hid it from every other
    signed-out visitor, on every device.
    """
    assert client.post("/api/release/changelog", json={"version": "5.0.0"}).status_code == 401

    client.post(
        "/api/release/changelog",
        json={"version": "5.0.0"},
        headers={"Authorization": "Bearer dev_dismisser_one"},
    )
    other = client.get(
        "/api/release/changelog", headers={"Authorization": "Bearer dev_dismisser_two"}
    )
    assert other.json()["dismissed_versions"] == []
    assert client.get("/api/release/changelog").json()["dismissed_versions"] == []
