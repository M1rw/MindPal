from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from backend.core.config import Settings
from backend.services.persona_voice_catalog import PersonaVoiceCatalog


@dataclass(frozen=True, slots=True)
class VoiceV3LaunchValidation:
    enabled: bool
    verbal_cues_enabled: bool
    enabled_personas: tuple[str, ...]
    mapped_personas: tuple[str, ...]
    missing_personas: tuple[str, ...]
    endpoint_reachable: bool | None
    cache_warm_success: bool | None
    errors: tuple[str, ...]

    @property
    def ready(self) -> bool:
        return self.enabled and not self.errors and self.verbal_cues_enabled


def validate_production_voice_configuration(
    settings: Settings,
    *,
    catalog: PersonaVoiceCatalog | None = None,
    endpoint_probe: Callable[[], bool] | None = None,
    cache_warm_probe: Callable[[], bool] | None = None,
) -> VoiceV3LaunchValidation:
    enabled = bool(getattr(settings, "VOICE_V3_ENABLED", False))
    personas = _enabled_personas(getattr(settings, "VOICE_V3_ENABLED_PERSONAS", "Kore,Charon"))
    voice_catalog = catalog or PersonaVoiceCatalog(settings=settings)
    mapped: list[str] = []
    missing: list[str] = []
    errors: list[str] = []

    if enabled:
        for persona in personas:
            if voice_catalog.is_configured(persona):
                mapped.append(persona)
            else:
                missing.append(persona)
                errors.append(f"tts.persona_mapping_missing:{persona}")

    endpoint_reachable = None if endpoint_probe is None else _safe_probe(endpoint_probe, "tts.endpoint_unreachable", errors)
    cache_warm_success = None if cache_warm_probe is None else _safe_probe(cache_warm_probe, "tts.cache_warm_failed", errors)
    verbal_cues_enabled = enabled and not missing and (endpoint_reachable is not False) and (cache_warm_success is not False)

    return VoiceV3LaunchValidation(
        enabled=enabled,
        verbal_cues_enabled=verbal_cues_enabled,
        enabled_personas=tuple(personas),
        mapped_personas=tuple(mapped),
        missing_personas=tuple(missing),
        endpoint_reachable=endpoint_reachable,
        cache_warm_success=cache_warm_success,
        errors=tuple(errors),
    )


def _enabled_personas(raw: str) -> list[str]:
    seen: set[str] = set()
    personas: list[str] = []
    for value in raw.split(","):
        persona = value.strip()
        key = persona.lower()
        if persona and key not in seen:
            seen.add(key)
            personas.append(persona)
    return personas


def _safe_probe(probe: Callable[[], bool], error_code: str, errors: list[str]) -> bool:
    try:
        result = bool(probe())
    except Exception:
        result = False
    if not result:
        errors.append(error_code)
    return result
