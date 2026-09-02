# tests/integration/test_settings_wiring_contract.py

from __future__ import annotations

import pytest


def test_settings_round_trip_contract(auth_client):
    """
    Assert that updating all settings keys via PATCH /api/user/profile persists
    cleanly in ui_settings and locale, and round-trips via GET /api/user/profile.
    """
    ui_settings = {
        "appearance": "dark",
        "language": "ar-EG",
        "dictationEnabled": False,
        "notifications": {
            "responseComplete": "push",
            "streakReminders": "in_app",
            "moodCheckIn": "push",
        },
        "voice": {
            "model": "standard",
            "language": "ar",
        },
        "personalization": {
            "baseStyle": "candid",
            "warmth": "low",
            "useHeadersLists": False,
            "emojiSupport": False,
        },
        "memoryEnabled": True,
        "improveProduct": True,
        "crisisInterception": True,
    }

    patch_payload = {
        "preferences": {
            "locale": "ar-EG",
            "gender": "female",
            "ui_settings": ui_settings,
        }
    }

    patch_res = auth_client.patch("/api/user/profile", json=patch_payload)
    assert patch_res.status_code == 200, f"Patch profile failed: {patch_res.text}"

    get_res = auth_client.get("/api/user/profile")
    assert get_res.status_code == 200
    data = get_res.json()

    saved_prefs = data["profile"]["preferences"]
    assert saved_prefs["locale"] == "ar"
    assert saved_prefs["gender"] == "female"

    saved_ui = saved_prefs["ui_settings"]
    assert saved_ui["appearance"] == "dark"
    assert saved_ui["language"] == "ar-EG"
    assert saved_ui["dictationEnabled"] is False
    assert saved_ui["notifications"]["responseComplete"] == "push"
    assert saved_ui["notifications"]["streakReminders"] == "in_app"
    assert saved_ui["notifications"]["moodCheckIn"] == "push"
    assert saved_ui["voice"]["model"] == "standard"
    assert saved_ui["voice"]["language"] == "ar"
    assert saved_ui["personalization"]["baseStyle"] == "candid"
    assert saved_ui["personalization"]["warmth"] == "low"
    assert saved_ui["personalization"]["useHeadersLists"] is False
    assert saved_ui["personalization"]["emojiSupport"] is False
    assert saved_ui["improveProduct"] is True
    assert saved_ui["crisisInterception"] is True


def test_product_improvement_signals_endpoint(auth_client):
    """
    Assert that POST /api/user/improvement-signals updates user product improvement opt-in preference.
    """
    res_on = auth_client.post("/api/user/improvement-signals", json={"opt_in": True})
    assert res_on.status_code == 200
    assert res_on.json()["opt_in"] is True
    assert res_on.json()["status"] == "updated"

    res_off = auth_client.post("/api/user/improvement-signals", json={"opt_in": False})
    assert res_off.status_code == 200
    assert res_off.json()["opt_in"] is False
    assert res_off.json()["status"] == "updated"
