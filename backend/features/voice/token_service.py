# backend/features/voice/token_service.py

"""
Voice V4 ephemeral-token provider boundary.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
import logging
from urllib.parse import urlparse

import httpx

from backend.core.config import Settings
from backend.core.errors import AuthError, ProviderError, ProviderTimeoutError
from backend.core.security import sanitize_text
from backend.models.feature_flags import FeatureContext, FeatureEvaluation
from backend.models.voice_v4_layer0 import VOICE_V4_CONTRACT, evaluate_voice_v4_release
from backend.providers._shared import setting_secret

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class VoiceV4TokenGrant:
    token: str
    expires_at_utc: datetime
    new_session_expires_at_utc: datetime
    model: str
    protocol_version: str
    request_id: str

    def to_public_dict(self) -> dict[str, object]:
        return {
            "token": self.token,
            "expires_at_utc": self.expires_at_utc.isoformat().replace("+00:00", "Z"),
            "new_session_expires_at_utc": self.new_session_expires_at_utc.isoformat().replace("+00:00", "Z"),
            "model": self.model,
            "protocol_version": self.protocol_version,
            "request_id": self.request_id,
        }


class VoiceV4TokenService:
    name = "voice_v4_token"

    def __init__(self, *, settings: Settings, client: httpx.AsyncClient | None = None) -> None:
        self.settings = settings
        self._client = client

    @property
    def is_configured(self) -> bool:
        return bool(setting_secret(self.settings, "GEMINI_API_KEY")) and bool(
            str(getattr(self.settings, "VOICE_V4_TOKEN_ENDPOINT", "") or "")
        )

    async def issue_token(
        self,
        *,
        feature: FeatureEvaluation | None,
        feature_context: FeatureContext,
        request_id: str,
    ) -> VoiceV4TokenGrant:
        if not feature_context.authenticated or not feature_context.user_id_hash:
            raise AuthError("Authentication is required for Voice V4 token issuance", code="voice_authentication_required")

        decision = evaluate_voice_v4_release(
            feature,
            environment=self.settings.ENVIRONMENT,
            explicit_approval=bool(self.settings.VOICE_V4_PREVIEW_APPROVED),
        )
        if not decision.allowed:
            raise ProviderError("Voice V4 release is not available", code=f"voice_{decision.reason.value}", details={"release_reason": decision.reason.value})

        if not self.is_configured:
            raise ProviderError("Voice V4 provider is not configured", code="voice_provider_not_configured")

        endpoint = _validate_endpoint(self.settings.VOICE_V4_TOKEN_ENDPOINT)
        api_key = setting_secret(self.settings, "GEMINI_API_KEY")

        if api_key and not str(api_key).startswith("AIza"):
            logger.warning(
                "voice_v4_token_key_format_warning: GEMINI_API_KEY does not start with 'AIza'. "
                "The Voice Live API requires a Google AI Studio key from https://aistudio.google.com/apikey."
            )

        now = datetime.now(UTC)
        expires_at = now + timedelta(seconds=self.settings.VOICE_V4_TOKEN_TTL_SECONDS)
        new_session_expires_at = now + timedelta(seconds=self.settings.VOICE_V4_NEW_SESSION_TTL_SECONDS)
        model_name = getattr(self.settings, "VOICE_V4_MODEL", None) or VOICE_V4_CONTRACT.model
        payload = {
            "uses": 1,
            "expireTime": expires_at.astimezone(UTC).isoformat().replace("+00:00", "Z"),
            "newSessionExpireTime": new_session_expires_at.astimezone(UTC).isoformat().replace("+00:00", "Z"),
            "liveConnectConstraints": {
                "model": model_name,
                "config": {
                    "responseModalities": [VOICE_V4_CONTRACT.response_modality],
                },
            },
        }

        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self.settings.REQUEST_TIMEOUT_SECONDS)
        try:
            response = await client.post(
                endpoint,
                headers={
                    "x-goog-api-key": api_key,
                    "content-type": "application/json",
                },
                json=payload,
            )
            if response.status_code >= 400:
                logger.error(
                    "voice_v4_token_provider_rejected status=%s response=%s",
                    response.status_code,
                    response.text[:500],
                )
                raise ProviderError(
                    "Voice V4 token provider rejected the request",
                    code="voice_provider_unavailable",
                    details={"provider_status": min(response.status_code, 599)},
                )

            try:
                response_data = response.json()
            except ValueError as exc:
                raise ProviderError(
                    "Voice V4 token provider returned an invalid response",
                    code="voice_provider_invalid_response",
                ) from exc

            value = response_data.get("name") or response_data.get("token")
            if not isinstance(value, str) or not value.strip():
                raise ProviderError(
                    "Voice V4 token provider returned an invalid response",
                    code="voice_provider_invalid_response",
                )
            token = value.strip()
            return VoiceV4TokenGrant(
                token=token,
                expires_at_utc=expires_at,
                new_session_expires_at_utc=new_session_expires_at,
                model=model_name,
                protocol_version=VOICE_V4_CONTRACT.provider_protocol,
                request_id=request_id,
            )
        except httpx.TimeoutException as exc:
            raise ProviderTimeoutError(
                "Voice V4 token provider timed out",
                code="voice_provider_timeout",
            ) from exc
        except httpx.HTTPError as exc:
            raise ProviderError(
                "Voice V4 token provider request failed",
                code="voice_provider_unavailable",
            ) from exc
        finally:
            if owns_client:
                await client.aclose()


def _validate_endpoint(endpoint: str) -> str:
    value = sanitize_text(endpoint, 300).rstrip("/")
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        raise ProviderError(
            "Voice V4 token provider endpoint is invalid",
            code="voice_configuration_invalid",
        )
    return value

