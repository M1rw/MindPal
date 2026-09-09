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


from unittest.mock import AsyncMock

import pytest

from backend.models.user import ClinicalProfile, ClinicalScore, UserProfile
from backend.services.domain.storage import StorageService


@pytest.mark.asyncio
async def test_clinical_score_iso8601_and_projection(caplog):
    profile = UserProfile(
        user_id_hash="usr_test_projection",
        clinical=ClinicalProfile(
            phq9_history=[ClinicalScore(date="2026-09-01", score=14)],
            gad7_history=[ClinicalScore(date="2026-09-01T12:00:00Z", score=8)],
        )
    )

    # Validate ISO-8601 timestamp normalization
    assert profile.clinical.phq9_history[0].date == "2026-09-01T00:00:00Z"
    assert profile.clinical.gad7_history[0].date == "2026-09-01T12:00:00Z"

    storage = StorageService()
    mock_supabase = AsyncMock()
    storage.supabase_client = mock_supabase

    # Successful projection test
    res = await storage.sync_clinical_scores_to_supabase_projection(profile)
    assert res is True
    mock_supabase.upsert.assert_called_once()
    upsert_args = mock_supabase.upsert.call_args[0]
    assert upsert_args[0] == "clinical_screenings"
    assert len(upsert_args[1]) == 2

    # Projection failure alert test
    mock_supabase.upsert.side_effect = Exception("Supabase network error")
    res_fail = await storage.sync_clinical_scores_to_supabase_projection(profile)
    assert res_fail is False
    assert "clinical_score_projection_failed" in caplog.text
