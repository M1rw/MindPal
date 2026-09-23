from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, Optional

from backend.core.errors import AppError
from backend.domain.voice.providers.gemini.errors import PROVIDER_UNAVAILABLE_MESSAGE


def sdk_config(
    *,
    expire_at: datetime,
    new_session_expire_at: datetime,
    model: str,
    voice_id: str,
    safety: bool = True,
    session_resumption: bool = False,
    resumption_handle: str | None = None,
    proactivity: bool = True,
    compression: bool = True,
    personalization: Optional[Dict[str, Any]] = None,
    voice_language: Optional[str] = None,
) -> Dict[str, Any]:
    from backend.domain.voice.services.token import (
        live_activity_detection_snake,
        live_compression_snake,
        live_face_tool_snake,
        live_mood_tool_snake,
        live_proactivity_snake,
        live_recall_tools,
        live_risk_tool_snake,
        live_safety_settings_snake,
        wellness_live_instruction,
    )

    config: Dict[str, Any] = {
        **({"safety_settings": live_safety_settings_snake()} if safety else {}),
        "response_modalities": ["AUDIO"],
        "temperature": __import__("backend.domain.voice.services.token", fromlist=["LIVE_TEMPERATURE"]).LIVE_TEMPERATURE,
        "speech_config": {"voice_config": {"prebuilt_voice_config": {"voice_name": voice_id}}},
        "system_instruction": wellness_live_instruction(
            voice_id=voice_id,
            personalization=personalization,
            voice_language=voice_language,
        ),
        "realtime_input_config": {"automatic_activity_detection": live_activity_detection_snake()},
        "input_audio_transcription": {},
        "output_audio_transcription": {},
        "tools": [{"function_declarations": [
            live_face_tool_snake(), live_mood_tool_snake(), live_risk_tool_snake(), *live_recall_tools()
        ]}],
        **({"proactivity": live_proactivity_snake()} if proactivity else {}),
        **({"context_window_compression": live_compression_snake()} if compression else {}),
    }
    if session_resumption:
        handle = (resumption_handle or "").strip()
        config["session_resumption"] = {"handle": handle} if handle else {}
    return {
        "uses": 1,
        "expire_time": expire_at,
        "new_session_expire_time": new_session_expire_at,
        "live_connect_constraints": {"model": model, "config": config},
    }


def create_token(api_key: str, config: Dict[str, Any]) -> str:
    from google import genai
    from google.genai import errors as genai_errors
    from google.genai import types

    from backend.domain.voice.services.token import AUTH_TOKENS_URL

    client = genai.Client(
        api_key=api_key,
        http_options=types.HttpOptions(api_version="v1alpha", timeout=10_000),
    )
    try:
        token = client.auth_tokens.create(config=config)
    except genai_errors.APIError as exc:
        status_name = str(exc.status or exc.code or "ERROR")
        message = (exc.message or str(exc)).strip() or "Gemini did not issue a session token."
        raise AppError(
            "unavailable",
            PROVIDER_UNAVAILABLE_MESSAGE,
            internal_message=f"Gemini {status_name}: {message[:180]}",
            details={
                "provider_status": min(int(exc.code or 503), 599),
                "provider_status_name": status_name,
                "provider_endpoint": AUTH_TOKENS_URL,
            },
        ) from exc
    finally:
        client.close()
    name = getattr(token, "name", None)
    if not isinstance(name, str) or not name.strip():
        raise AppError(
            "unavailable",
            "Live voice could not start. The token provider returned an empty credential.",
        )
    return name.strip()
