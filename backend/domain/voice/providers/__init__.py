"""Voice provider family registry.

The concrete provider implementations live beneath a provider-family namespace
such as backend.domain.voice.providers.gemini. The flat modules remain as
compatibility shims for older imports while the new family structure is the
authoritative implementation.
"""

from backend.domain.voice.providers.gemini import (
	PROVIDER_UNAVAILABLE_MESSAGE,
	create_token,
	extract_token,
	google_mint_error_message,
	post_auth_tokens,
	raise_provider_http,
	rejects_context_window_compression,
	rejects_named_setup_field,
	rejects_proactivity,
	rejects_safety_settings,
	rejects_session_resumption,
	sdk_config,
	should_try_beta,
)

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