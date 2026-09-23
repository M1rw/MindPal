"""Gemini provider family for voice token minting and transport helpers.

The provider package is organized by provider family first and then by mode.
This keeps future providers (for example OpenAI or Anthropic) alongside Gemini
without mixing all token logic into a single flat module.
"""

from .errors import (
    PROVIDER_UNAVAILABLE_MESSAGE,
    google_mint_error_message,
    raise_provider_http,
    rejects_context_window_compression,
    rejects_named_setup_field,
    rejects_proactivity,
    rejects_safety_settings,
    rejects_session_resumption,
    should_try_beta,
)
from .rest import extract_token, post_auth_tokens
from .sdk import create_token, sdk_config

__all__ = [
    "PROVIDER_UNAVAILABLE_MESSAGE",
    "google_mint_error_message",
    "raise_provider_http",
    "rejects_context_window_compression",
    "rejects_named_setup_field",
    "rejects_proactivity",
    "rejects_safety_settings",
    "rejects_session_resumption",
    "should_try_beta",
    "extract_token",
    "post_auth_tokens",
    "create_token",
    "sdk_config",
]
