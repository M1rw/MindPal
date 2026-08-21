from __future__ import annotations

from types import SimpleNamespace

from backend.services.persona_voice_catalog import PersonaVoice, PersonaVoiceCatalog
from backend.services.voice_v3_feature_flags import VoiceV3FlagContext, evaluate_voice_v3_flags
from backend.services.voice_v3_launch_gate import validate_production_voice_configuration


def settings(**overrides: object) -> SimpleNamespace:
    values = {
        "VOICE_V3_ENABLED": True,
        "VOICE_V3_VERBAL_CUES_ENABLED": True,
        "VOICE_V3_PROSODY_CONTEXT_ENABLED": True,
        "VOICE_V3_MEMORY_ENABLED": True,
        "VOICE_V3_CLARIFICATION_ENABLED": True,
        "VOICE_V3_ENABLED_PERSONAS": "Kore,Charon",
        "VOICE_V3_ROLLOUT_PERCENT": 100,
        "CAMB_KORE_VOICE_ID": "kore-id",
        "CAMB_CHARON_VOICE_ID": "charon-id",
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def catalog() -> PersonaVoiceCatalog:
    return PersonaVoiceCatalog({
        "Kore": PersonaVoice("Kore", "camb", "kore-id", "female", "warm_natural"),
        "Charon": PersonaVoice("Charon", "camb", "charon-id", "male", "calm_deep"),
    })


def test_flags_are_evaluable_by_environment_user_and_session() -> None:
    result = evaluate_voice_v3_flags(
        settings(),
        VoiceV3FlagContext(
            environment="staging",
            user_key="user-1",
            session_key="session-1",
            user_overrides={"VOICE_V3_MEMORY_ENABLED": False},
            session_overrides={"VOICE_V3_PROSODY_CONTEXT_ENABLED": False},
        ),
    )
    assert result["VOICE_V3_ENABLED"] is True
    assert result["VOICE_V3_MEMORY_ENABLED"] is False
    assert result["VOICE_V3_PROSODY_CONTEXT_ENABLED"] is False


def test_disabled_v3_does_not_require_persona_mapping_or_probe() -> None:
    result = validate_production_voice_configuration(settings(VOICE_V3_ENABLED=False), catalog=catalog())
    assert result.enabled is False
    assert result.verbal_cues_enabled is False
    assert result.ready is False
    assert result.errors == ()


def test_enabled_personas_require_explicit_voice_ids_and_probe_success() -> None:
    result = validate_production_voice_configuration(
        settings(),
        catalog=catalog(),
        endpoint_probe=lambda: True,
        cache_warm_probe=lambda: True,
    )
    assert result.ready is True
    assert result.mapped_personas == ("Kore", "Charon")
    assert result.endpoint_reachable is True
    assert result.cache_warm_success is True


def test_missing_mapping_disables_verbal_cues_without_crashing() -> None:
    result = validate_production_voice_configuration(
        settings(VOICE_V3_ENABLED_PERSONAS="Kore,Charon"),
        catalog=PersonaVoiceCatalog({"Kore": PersonaVoice("Kore", "camb", "kore-id", "female", "warm_natural")}),
    )
    assert result.enabled is True
    assert result.verbal_cues_enabled is False
    assert result.missing_personas == ("Charon",)
    assert "tts.persona_mapping_missing:Charon" in result.errors
