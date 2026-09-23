from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, ValidationError

from backend.configs.settings import get_settings

_JSON_DIR = Path(__file__).with_name("json")
_SCHEMA_DIR = Path(__file__).with_name("schemas")
_RUNTIME_CONFIG_NAMES = (
    "quota",
    "voice_runtime",
    "safety",
    "api_limits",
    "domain_limits",
    "wellness_rules",
    "behavior",
    "voice_tools",
    "adaptation",
    "dynamic",
)


@dataclass(frozen=True, slots=True)
class VoicePolicyConfig:
    guest_max_session_seconds: int
    guest_daily_cap_seconds: int
    guest_reserve_seconds: int
    guest_min_session_seconds: int
    guest_allow_reconnect: bool
    guest_allow_persistent_memory: bool
    guest_fallback_mode: str
    account_max_session_seconds: int
    account_daily_cap_seconds: int
    account_reserve_seconds: int
    account_min_session_seconds: int
    account_allow_reconnect: bool
    account_allow_persistent_memory: bool
    account_fallback_mode: str


@dataclass(frozen=True, slots=True)
class VoiceSessionConfig:
    reserve_seconds: int
    daily_cap_seconds: int
    min_session_seconds: int
    provider_rotate_seconds: int
    ledger_chars: int
    hold_ms: int
    transcript_buffer_chars: int
    safety_stale_seconds: int
    safety_heartbeat_ms: int
    abandoned_unwarmed_seconds: int
    setup_failure_max_seconds: int
    retention_seconds: int


@dataclass(frozen=True, slots=True)
class VoiceRuntimeSettings:
    policy: VoicePolicyConfig
    session: VoiceSessionConfig


@lru_cache(maxsize=1)
def voice_runtime_settings() -> VoiceRuntimeSettings:
    config = voice_runtime_config()
    policy = config["policy"]
    session = config["session"]
    return VoiceRuntimeSettings(
        policy=VoicePolicyConfig(**policy),
        session=VoiceSessionConfig(**session),
    )

@lru_cache(maxsize=None)
def _runtime_validator(name: str) -> Draft202012Validator:
    schema_path = _SCHEMA_DIR / f"{name}.schema.json"
    if not schema_path.exists():
        raise ValueError(
            f"Missing schema for runtime config {name!r}: {schema_path.name}"
        )
    with schema_path.open("r", encoding="utf-8") as schema_file:
        schema = json.load(schema_file)
    try:
        Draft202012Validator.check_schema(schema)
    except Exception as exc:
        raise ValueError(f"Invalid runtime schema {schema_path.name}: {exc}") from exc
    return Draft202012Validator(schema)


def _validate_runtime_schema(name: str, payload: dict[str, Any]) -> None:
    try:
        _runtime_validator(name).validate(payload)
    except ValidationError as exc:
        path = ".".join(str(part) for part in exc.absolute_path)
        location = f" at {path}" if path else ""
        raise ValueError(
            f"Runtime config {name!r} failed schema validation{location}: {exc.message}"
        ) from exc


@lru_cache(maxsize=None)
def load_runtime_config(name: str) -> dict[str, Any]:
    path = _JSON_DIR / f"{name}.json"
    if not path.exists():
        raise ValueError(f"Unknown runtime config: {name!r}. Expected one of: {', '.join(_RUNTIME_CONFIG_NAMES)}")
    with path.open("r", encoding="utf-8") as config_file:
        payload = json.load(config_file)
    if not isinstance(payload, dict):
        raise ValueError(f"{path.name} must contain an object")
    _validate_runtime_schema(name, payload)
    return payload


def validate_runtime_config(name: str) -> dict[str, Any]:
    if name not in _RUNTIME_CONFIG_NAMES:
        raise ValueError(f"Unknown runtime config: {name!r}. Expected one of: {', '.join(_RUNTIME_CONFIG_NAMES)}")

    payload = load_runtime_config(name)
    _validate_runtime_schema(name, payload)
    if not payload:
        raise ValueError(f"Runtime config {name!r} is empty")
    return payload


def validate_runtime_configs() -> dict[str, dict[str, Any]]:
    return {name: validate_runtime_config(name) for name in _RUNTIME_CONFIG_NAMES}


def ensure_runtime_ready() -> None:
    validate_runtime_configs()
    get_settings().validate_runtime()


def quota_config() -> dict[str, Any]:
    return load_runtime_config("quota")


def voice_runtime_config() -> dict[str, Any]:
    return load_runtime_config("voice_runtime")


def safety_config() -> dict[str, Any]:
    return load_runtime_config("safety")


def api_limits_config() -> dict[str, Any]:
    return load_runtime_config("api_limits")


def domain_limits_config() -> dict[str, Any]:
    return load_runtime_config("domain_limits")


def wellness_rules_config() -> dict[str, Any]:
    return load_runtime_config("wellness_rules")


def behavior_config() -> dict[str, Any]:
    return load_runtime_config("behavior")


def voice_tools_config() -> dict[str, Any]:
    return load_runtime_config("voice_tools")


def adaptation_config() -> dict[str, Any]:
    return load_runtime_config("adaptation")


def dynamic_config() -> dict[str, Any]:
    return load_runtime_config("dynamic")
