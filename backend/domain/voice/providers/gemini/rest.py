from __future__ import annotations

import logging
from typing import Any, Dict

import httpx

from backend.core.errors import AppError
from backend.domain.voice.providers.gemini.errors import raise_provider_http

logger = logging.getLogger("mindpal.voice")


def post_auth_tokens(
    url: str,
    headers: Dict[str, str],
    payload: Dict[str, Any],
    timeout: float,
) -> Dict[str, Any]:
    with httpx.Client(timeout=timeout) as client:
        response = client.post(url, headers=headers, json=payload)
    if response.status_code >= 400:
        logger.warning(
            "voice_token_provider_rejected status=%s endpoint=%s",
            response.status_code,
            url,
        )
        raise_provider_http(response.status_code, response.text, endpoint=url)
    try:
        data = response.json()
    except ValueError as exc:
        raise AppError(
            "unavailable",
            "Live voice could not start. The token provider returned an invalid response.",
        ) from exc
    if not isinstance(data, dict):
        raise AppError(
            "unavailable",
            "Live voice could not start. The token provider returned an invalid response.",
        )
    return data


def extract_token(response_data: Dict[str, Any]) -> str:
    value = response_data.get("name") or response_data.get("token")
    if not isinstance(value, str):
        raise AppError(
            "unavailable",
            "Live voice could not start. The token provider returned an empty credential.",
        )
    token = value.strip()
    if not token or token.startswith("vt_"):
        raise AppError(
            "unavailable",
            "Live voice could not start. The token provider returned an empty credential.",
        )
    return token
