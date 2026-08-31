# tests/unit/core/test_import_policy.py

import pytest
import importlib


@pytest.mark.parametrize(
    "old_module_path",
    [
        "backend.services.llm_service",
        "backend.services.safety_service",
        "backend.services.memory_service",
        "backend.services.rag_service",
        "backend.services.tts_service",
        "backend.services.auth_service",
        "backend.services.db_service",
        "backend.services.feature_flags_service",
        "backend.services.feature_policy_repository",
        "backend.services.quota_service",
        "backend.services.rate_limit_service",
        "backend.services.idempotency_service",
        "backend.services.response_intelligence_service",
        "backend.services.response_quality_service",
        "backend.services.clinical_extractor",
        "backend.services.admin_authority",
        "backend.services.supabase_admin_repository",
        "backend.services.supabase_feature_policy_repository",
        "backend.services.voice_v4_token_service",
        "backend.services.brain_service",
        "backend.services.memory_graph_service",
    ],
)
def test_legacy_service_shims_are_deleted(old_module_path: str):
    """Ensure old top-level service shims cannot be imported."""
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module(old_module_path)
