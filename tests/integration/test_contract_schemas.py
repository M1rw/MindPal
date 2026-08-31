# tests/integration/test_contract_schemas.py

from __future__ import annotations

import pytest
from backend.models.chat import ChatResponse
from backend.models.user import UserProfileResponse, UserSession
from backend.models.memory import MemoryGraphLoadResult, MemoryCompactionResult
from backend.models.brain import BrainOverview, BrainMapView, BrainContextPack
from backend.models.safety import SafetyDecision
from backend.models.schemas import HealthResponse, TTSResponse, ProviderChainTrace


def test_chat_response_contract(auth_client):
    payload = {
        "message": "What is the capital of France?",
        "history": [],
        "metadata": {"locale": "en"},
    }
    res = auth_client.post("/api/chat", json=payload)
    assert res.status_code == 200
    model = ChatResponse.model_validate(res.json())
    assert model.reply != ""
    assert model.request_id != ""


def test_user_profile_contract(auth_client):
    res = auth_client.get("/api/user/profile")
    assert res.status_code == 200
    model = UserProfileResponse.model_validate(res.json())
    assert model.profile.user_id_hash != ""


def test_memory_v3_contract(auth_client):
    res = auth_client.get("/api/memory/v3")
    assert res.status_code == 200
    model = MemoryGraphLoadResult.model_validate(res.json())
    assert model.graph.user_id_hash != ""


def test_brain_overview_contract(auth_client):
    res = auth_client.get("/api/brain/overview")
    assert res.status_code == 200
    model = BrainOverview.model_validate(res.json())
    assert model.visible_node_count >= 0


def test_brain_map_contract(auth_client):
    res = auth_client.get("/api/brain/map")
    assert res.status_code == 200
    model = BrainMapView.model_validate(res.json())
    assert isinstance(model.nodes, list)


def test_brain_context_plan_contract(auth_client):
    res = auth_client.post("/api/brain/context-plan", json={"query": "my goals"})
    assert res.status_code == 200
    model = BrainContextPack.model_validate(res.json())
    assert isinstance(model.nodes, list)


def test_tts_synthesize_contract(auth_client):
    res = auth_client.post("/api/tts/synthesize", json={"text": "Test speech", "locale": "en"})
    assert res.status_code == 200
    model = TTSResponse.model_validate(res.json())
    assert model.audio_base64 != "" or model.fallback_to_browser is True
