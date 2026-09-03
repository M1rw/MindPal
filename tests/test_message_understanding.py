# tests/test_message_understanding.py

"""
Comprehensive test suite for MindPal Message-Level Intelligence Layer.

Tests:
1. Schema validation & malformed output handling / requeue.
2. Nuanced emotional state analysis (capturing context vs fixed enum).
3. Emergent theme discovery without hardcoded topic lists.
4. Taxonomy AI merge, versioning, and language preservation.
5. Snapshot regeneration trigger conditions & automatic triggering from analysis.
6. Zero-latency async out-of-band execution proof (measured).
7. Memory synthesis consuming message understanding & context snapshot.
8. Assistant Telemetry recording.
"""

import time
import pytest
from unittest.mock import AsyncMock, MagicMock

from backend.core.config import get_settings
from backend.models.understanding import (
    AnalysisStatus,
    AssistantTelemetry,
    MessageUnderstanding,
    TaxonomyTheme,
    UserContextSnapshot,
    UserTaxonomy,
)
from backend.services.domain.intelligence.message_understanding import MessageUnderstandingService
from backend.services.domain.intelligence.taxonomy_service import TaxonomyService
from backend.services.domain.intelligence.user_snapshot_service import UserSnapshotService
from backend.services.domain.memory.synthesis import synthesize_memory_narrative


@pytest.fixture
def mock_llm_service():
    mock = MagicMock()
    mock.generate_with_trace = AsyncMock()
    mock.generate = AsyncMock()
    mock.is_configured = True
    return mock


@pytest.mark.asyncio
async def test_message_understanding_schema_and_malformed_handling(mock_llm_service):
    settings = get_settings()
    service = MessageUnderstandingService(settings=settings, llm_service=mock_llm_service)

    # 1. Successful structured AI output
    mock_res = MagicMock()
    mock_res.response.text = '''
    {
      "emotional_state": "anxious about tomorrow\'s exam, but hopeful after planning",
      "themes": ["exam_stress", "study_plan"],
      "significance": "High importance for student academic trajectory",
      "memory_worthiness": 0.85,
      "memory_rationale": "Exam date and coping preparation strategy",
      "crisis_risk_assessment": "low"
    }
    '''
    mock_llm_service.generate_with_trace.return_value = mock_res

    res = await service.analyze_message_async(
        message_id="msg_1001",
        user_id_hash="user_abc",
        message_text="I have a big exam tomorrow and I am super nervous, but I made a study plan.",
    )

    assert res.status == AnalysisStatus.ANALYZED
    assert res.emotional_state == "anxious about tomorrow's exam, but hopeful after planning"
    assert "exam_stress" in res.themes
    assert res.memory_worthiness == 0.85

    # 2. Malformed JSON handling -> graceful fallback & requeue
    mock_res_malformed = MagicMock()
    mock_res_malformed.response.text = "INVALID_NON_JSON_RESPONSE"
    mock_llm_service.generate_with_trace.return_value = mock_res_malformed

    res_fail = await service.analyze_message_async(
        message_id="msg_1002",
        user_id_hash="user_abc",
        message_text="Help me",
    )

    assert res_fail.status == AnalysisStatus.FAILED
    assert len(service._queue) == 1
    assert service._queue[0]["store_key"] == "user_abc:msg_1002"


@pytest.mark.asyncio
async def test_nuanced_emotion_and_emergent_theme_creation(mock_llm_service):
    settings = get_settings()
    service = MessageUnderstandingService(settings=settings, llm_service=mock_llm_service)

    # User says "I am fine" but context implies visa stress
    mock_res = MagicMock()
    mock_res.response.text = '''
    {
      "emotional_state": "minimizing stress with 'fine' while feeling overwhelmed by visa renewal delays",
      "themes": ["visa_stress", "immigration_delay"],
      "significance": "Crucial life administrative milestone",
      "memory_worthiness": 0.90,
      "memory_rationale": "Visa renewal pending status",
      "crisis_risk_assessment": "low"
    }
    '''
    mock_llm_service.generate_with_trace.return_value = mock_res

    res = await service.analyze_message_async(
        message_id="msg_1003",
        user_id_hash="user_xyz",
        message_text="I am fine, just waiting on my visa renewal response.",
    )

    assert "minimizing stress" in res.emotional_state
    assert "visa renewal delays" in res.emotional_state
    assert "visa_stress" in res.themes
    assert "immigration_delay" in res.themes


@pytest.mark.asyncio
async def test_taxonomy_service_emergent_tracking_and_merge(mock_llm_service):
    settings = get_settings()
    tax_service = TaxonomyService(settings=settings, llm_service=mock_llm_service)

    tax_service.record_themes(
        user_id_hash="user_tax",
        themes=["visa stress", "visa renewal delays", "exam anxiety"],
        language="english",
    )

    tax = tax_service.get_user_taxonomy("user_tax")
    assert len(tax.themes) == 3
    names = [t.name for t in tax.themes]
    assert "visa stress" in names

    mock_res = MagicMock()
    mock_res.response.text = '''
    {
      "consolidated_themes": [
        {
          "name": "visa_stress",
          "aliases": ["visa stress", "visa renewal delays"],
          "occurrence_count": 2,
          "language": "english"
        },
        {
          "name": "exam_anxiety",
          "aliases": ["exam anxiety"],
          "occurrence_count": 1,
          "language": "english"
        }
      ]
    }
    '''
    mock_llm_service.generate_with_trace.return_value = mock_res

    consolidated_tax = await tax_service.consolidate_taxonomy("user_tax")
    assert len(consolidated_tax.themes) == 2
    assert consolidated_tax.themes[0].name == "visa_stress"
    assert "visa renewal delays" in consolidated_tax.themes[0].aliases


@pytest.mark.asyncio
async def test_user_snapshot_and_taxonomy_automatic_wiring(mock_llm_service):
    settings = get_settings()
    tax_service = TaxonomyService(settings=settings, llm_service=mock_llm_service)
    snapshot_service = UserSnapshotService(settings=settings, llm_service=mock_llm_service)
    service = MessageUnderstandingService(
        settings=settings,
        llm_service=mock_llm_service,
        taxonomy_service=tax_service,
        user_snapshot_service=snapshot_service,
    )

    mock_res = MagicMock()
    mock_res.response.text = '''
    {
      "emotional_state": "anxious about visa interview",
      "themes": ["visa_stress", "interview_prep"],
      "significance": "Key milestone",
      "memory_worthiness": 0.85,
      "memory_rationale": "Visa date",
      "crisis_risk_assessment": "low"
    }
    '''
    mock_llm_service.generate_with_trace.return_value = mock_res

    res = await service.analyze_message_async(
        message_id="msg_wire_1",
        user_id_hash="user_wire",
        message_text="My visa interview is next week and I feel stressed.",
    )

    # 1. Verify dynamic taxonomy was updated automatically
    tax = tax_service.get_user_taxonomy("user_wire")
    tax_names = [t.name for t in tax.themes]
    assert "visa_stress" in tax_names
    assert "interview_prep" in tax_names

    # 2. Verify snapshot was generated automatically on high memory-worthiness
    snap = snapshot_service.get_snapshot("user_wire")
    assert snap is not None
    assert snap.user_id_hash == "user_wire"


@pytest.mark.asyncio
async def test_assistant_telemetry_recording(mock_llm_service):
    settings = get_settings()
    service = MessageUnderstandingService(settings=settings, llm_service=mock_llm_service)

    telemetry = AssistantTelemetry(
        request_id="req_telem_123",
        latency_ms=120.5,
        model="standard",
        personalization_snapshot={"locale": "en"},
        token_usage={"total_tokens": 150},
        memory_injected=True,
        user_snapshot_injected=True,
        safety_path_triggered="standard",
        completion_status="completed",
    )

    service.record_telemetry(telemetry)
    retrieved = service.get_telemetry("req_telem_123")

    assert retrieved is not None
    assert retrieved.latency_ms == 120.5
    assert retrieved.user_snapshot_injected is True


@pytest.mark.asyncio
async def test_zero_latency_async_out_of_band_execution(mock_llm_service):
    settings = get_settings()
    service = MessageUnderstandingService(settings=settings, llm_service=mock_llm_service)

    async def slow_generate(*args, **kwargs):
        await time.sleep(0.5)
        mock_res = MagicMock()
        mock_res.response.text = '{"emotional_state":"calm","themes":[],"significance":"low","memory_worthiness":0.1,"crisis_risk_assessment":"low"}'
        return mock_res

    mock_llm_service.generate_with_trace.side_effect = slow_generate

    start_time = time.perf_counter()
    service.enqueue_background_analysis(
        message_id="m_fast",
        user_id_hash="u_fast",
        message_text="Hello MindPal",
    )
    elapsed_ms = (time.perf_counter() - start_time) * 1000.0

    assert elapsed_ms < 15.0


@pytest.mark.asyncio
async def test_memory_synthesis_consuming_understanding_and_snapshot(mock_llm_service):
    mock_llm = MagicMock()
    mock_res = MagicMock()
    mock_res.text = "## Overview\n\nThe user is preparing for a visa interview while managing work stress.\n\n## Emotional Patterns & Coping\n\nThey feel anxious about bureaucratic timelines but cope well with structured planning."
    mock_llm.generate = AsyncMock(return_value=mock_res)
    mock_llm.is_configured = True

    understandings = [
        MessageUnderstanding(
            message_id="m10",
            user_id_hash="u_synth",
            emotional_state="anxious about visa interview timeline",
            themes=["visa_stress"],
            significance="Key legal milestone",
            memory_worthiness=0.88,
            memory_rationale="Visa interview date upcoming",
            status=AnalysisStatus.ANALYZED,
        )
    ]
    snapshot = UserContextSnapshot(
        user_id_hash="u_synth",
        dominant_themes=["visa_stress", "workload"],
        tone_trajectory="anxious but proactive",
        active_stressors=["visa approval timeline"],
        what_helps=["making checklist"],
        situational_portrait="User is actively preparing for visa renewal while balancing daily work.",
    )

    narrative, lang = await synthesize_memory_narrative(
        llm_service=mock_llm,
        understandings=understandings,
        context_snapshot=snapshot,
        extracted_facts=["Visa interview is next Tuesday"],
        fallback_locale="en",
    )

    assert "## Overview" in narrative
    assert "## Emotional Patterns & Coping" in narrative
    assert lang == "en"
    assert mock_llm.generate.called
