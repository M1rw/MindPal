# backend/providers/camb_provider.py

from __future__ import annotations

import base64
from dataclasses import dataclass
from typing import Any

import httpx

from backend.core.config import Settings, get_settings
from backend.core.errors import ProviderError, ProviderTimeoutError
from backend.core.security import redact_basic_pii, sanitize_text
from backend.models.schemas import TTSFormat, TTSRequest, TTSResponse


DEFAULT_CAMB_BASE_URL = "https://client.camb.ai/apis"
DEFAULT_CAMB_SPEECH_MODEL = "mars-8.1-flash-beta"
DEFAULT_CAMB_VOICE_ID = 147320
DEFAULT_TIMEOUT_SECONDS = 45.0

MAX_BASE_URL_CHARS = 300
MAX_MODEL_CHARS = 120
MAX_API_KEY_CHARS = 4_000
MAX_TEXT_CHARS = 3_000
MAX_ERROR_CHARS = 600
MAX_VOICE_ID_CHARS = 120


@dataclass(frozen=True, slots=True)
class CambProviderConfig:
    api_key: str
    base_url: str = DEFAULT_CAMB_BASE_URL
    speech_model: str = DEFAULT_CAMB_SPEECH_MODEL
    default_voice_id: int = DEFAULT_CAMB_VOICE_ID
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
    apply_enhancement: bool | None = None

    @classmethod
    def from_settings(cls, settings: Settings | None = None) -> CambProviderConfig:
        settings = settings or get_settings()

        return cls(
            api_key=sanitize_text(
                str(getattr(settings, "CAMB_API_KEY", "") or ""),
                MAX_API_KEY_CHARS,
            ),
            base_url=sanitize_text(
                str(getattr(settings, "CAMB_BASE_URL", DEFAULT_CAMB_BASE_URL) or DEFAULT_CAMB_BASE_URL),
                MAX_BASE_URL_CHARS,
            ).rstrip("/"),
            speech_model=sanitize_text(
                str(getattr(settings, "CAMB_SPEECH_MODEL", DEFAULT_CAMB_SPEECH_MODEL) or DEFAULT_CAMB_SPEECH_MODEL),
                MAX_MODEL_CHARS,
            ),
            default_voice_id=_safe_int(
                getattr(settings, "CAMB_DEFAULT_VOICE_ID", DEFAULT_CAMB_VOICE_ID),
                default=DEFAULT_CAMB_VOICE_ID,
            ),
            timeout_seconds=float(
                getattr(settings, "CAMB_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS)
                or DEFAULT_TIMEOUT_SECONDS
            ),
            apply_enhancement=_optional_bool(getattr(settings, "CAMB_APPLY_ENHANCEMENT", None)),
        )


class CambProvider:
    """
    CAMB.AI streaming TTS provider for TTSService.

    Boundary:
    - no network call at import
    - no SDK import
    - API key is sent in x-api-key header only
    - public service policy decides whether external TTS is allowed
    - returned audio is normalized to base64 in TTSResponse
    """

    name = "camb"

    def __init__(
        self,
        config: CambProviderConfig | None = None,
        *,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.config = config or CambProviderConfig.from_settings()
        self._client = client

    @property
    def is_configured(self) -> bool:
        return bool(self.config.api_key)

    async def synthesize(self, request: TTSRequest) -> TTSResponse:
        if not self.is_configured:
            raise ProviderError(
                "Camb provider is not configured",
                code="camb_not_configured",
                details={"provider": self.name},
            )

        text = sanitize_text(request.text, MAX_TEXT_CHARS)

        if len(text) < 3:
            raise ProviderError(
                "Camb TTS text is too short",
                code="camb_text_too_short",
                details={"provider": self.name},
            )

        payload = self._build_stream_payload(request, text=text)
        headers = {
            "x-api-key": self.config.api_key,
            "Content-Type": "application/json",
            "Accept": _accept_header_for_format(request.format),
        }

        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self.config.timeout_seconds)

        try:
            response = await client.post(
                self._tts_stream_url(),
                headers=headers,
                json=payload,
            )

            if response.status_code >= 400:
                raise self._provider_http_error(response)

            audio_bytes = response.content

            if not audio_bytes:
                raise ProviderError(
                    "Camb returned empty audio",
                    code="camb_empty_audio",
                    details={"provider": self.name},
                )

            mime_type = response.headers.get("content-type") or _mime_type_for_format(request.format)

            return TTSResponse(
                request_id="tts_camb_stream",
                provider_used=self.name,
                fallback_to_browser=False,
                mime_type=sanitize_text(mime_type, 120),
                audio_url=None,
                audio_base64=base64.b64encode(audio_bytes).decode("ascii"),
                latency_ms=0.0,
            )

        except httpx.TimeoutException as exc:
            raise ProviderTimeoutError(
                "Camb TTS request timed out",
                code="camb_timeout",
                details={"provider": self.name},
            ) from exc

        except httpx.HTTPError as exc:
            raise ProviderError(
                "Camb HTTP request failed",
                code="camb_http_error",
                details={
                    "provider": self.name,
                    "error": _clean_error(str(exc)),
                },
            ) from exc

        finally:
            if owns_client:
                await client.aclose()

    async def list_voices(self) -> list[dict[str, Any]]:
        """
        Return sanitized voice metadata from /list-voices.

        This method is not used by the public TTS route yet, but it is useful
        for admin tooling and future voice selection UI.
        """
        if not self.is_configured:
            raise ProviderError(
                "Camb provider is not configured",
                code="camb_not_configured",
                details={"provider": self.name},
            )

        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self.config.timeout_seconds)

        try:
            response = await client.get(
                self._list_voices_url(),
                headers={"x-api-key": self.config.api_key},
            )

            if response.status_code >= 400:
                raise self._provider_http_error(response)

            data = response.json()
            voices = data.get("voices") if isinstance(data, dict) else data

            if not isinstance(voices, list):
                raise ProviderError(
                    "Camb voices response had unexpected shape",
                    code="camb_voices_invalid_shape",
                    details={"provider": self.name},
                )

            return [_sanitize_voice(item) for item in voices if isinstance(item, dict)]

        except httpx.TimeoutException as exc:
            raise ProviderTimeoutError(
                "Camb voices request timed out",
                code="camb_timeout",
                details={"provider": self.name},
            ) from exc

        except httpx.HTTPError as exc:
            raise ProviderError(
                "Camb voices HTTP request failed",
                code="camb_http_error",
                details={
                    "provider": self.name,
                    "error": _clean_error(str(exc)),
                },
            ) from exc

        except ValueError as exc:
            raise ProviderError(
                "Camb voices response was not valid JSON",
                code="camb_invalid_json",
                details={"provider": self.name},
            ) from exc

        finally:
            if owns_client:
                await client.aclose()

    def _tts_stream_url(self) -> str:
        return f"{self.config.base_url.rstrip('/')}/tts-stream"

    def _list_voices_url(self) -> str:
        return f"{self.config.base_url.rstrip('/')}/list-voices"

    def _build_stream_payload(self, request: TTSRequest, *, text: str) -> dict[str, Any]:
        output_format = _format_value(request.format)
        voice_id = _voice_id_for_request(request.voice_id, default=self.config.default_voice_id)

        output_configuration: dict[str, Any] = {
            "format": output_format,
        }

        if self.config.apply_enhancement is not None:
            output_configuration["apply_enhancement"] = self.config.apply_enhancement

        payload: dict[str, Any] = {
            "text": text,
            "language": _camb_locale(request.locale),
            "voice_id": voice_id,
            "speech_model": sanitize_text(self.config.speech_model, MAX_MODEL_CHARS),
            "output_configuration": output_configuration,
            "voice_settings": {
                "speaking_rate": _clamp_speaking_rate(request.speaking_rate),
            },
        }

        return payload

    def _provider_http_error(self, response: httpx.Response) -> ProviderError:
        status_code = response.status_code
        code = "camb_http_error"
        message = ""

        try:
            data = response.json()
        except ValueError:
            data = {}

        if isinstance(data, dict):
            detail = data.get("detail")

            if isinstance(detail, list):
                message = "; ".join(
                    sanitize_text(str(item.get("msg") if isinstance(item, dict) else item), 200)
                    for item in detail[:5]
                )
                code = "camb_validation_error"

            elif isinstance(detail, str):
                message = sanitize_text(detail, MAX_ERROR_CHARS)

            elif isinstance(data.get("message"), str):
                message = sanitize_text(str(data["message"]), MAX_ERROR_CHARS)

            elif isinstance(data.get("error"), str):
                message = sanitize_text(str(data["error"]), MAX_ERROR_CHARS)

        if not message:
            message = sanitize_text(response.text, MAX_ERROR_CHARS)

        return ProviderError(
            "Camb provider returned an error",
            code=code,
            details={
                "provider": self.name,
                "status_code": str(status_code),
                "message": _clean_error(message),
            },
        )


def _camb_locale(locale: str) -> str:
    value = sanitize_text(locale or "auto", 40).lower().replace("_", "-")

    if value in {"ar", "ar-eg", "auto-ar"}:
        return "ar-eg"

    if value in {"en", "en-us", "auto", ""}:
        return "en-us"

    if "-" in value:
        return value

    return {
        "fr": "fr-fr",
        "es": "es-es",
        "de": "de-de",
        "it": "it-it",
        "pt": "pt-br",
        "tr": "tr-tr",
    }.get(value, "en-us")


def _voice_id_for_request(voice_id: str | None, *, default: int) -> int:
    cleaned = sanitize_text(str(voice_id or ""), MAX_VOICE_ID_CHARS)

    if cleaned.isdigit():
        return int(cleaned)

    return default


def _format_value(value: TTSFormat | str) -> str:
    raw = value.value if isinstance(value, TTSFormat) else str(value or "mp3")
    raw = sanitize_text(raw, 40).lower()

    if raw in {"mp3", "wav", "flac"}:
        return raw

    return "mp3"


def _mime_type_for_format(value: TTSFormat | str) -> str:
    output_format = _format_value(value)

    return {
        "mp3": "audio/mpeg",
        "wav": "audio/wav",
        "flac": "audio/flac",
    }.get(output_format, "application/octet-stream")


def _accept_header_for_format(value: TTSFormat | str) -> str:
    return _mime_type_for_format(value)


def _clamp_speaking_rate(value: float) -> float:
    return max(0.5, min(float(value), 2.0))


def _sanitize_voice(value: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": _safe_int(value.get("id"), default=0),
        "voice_name": sanitize_text(str(value.get("voice_name") or ""), 120),
        "gender": value.get("gender") if isinstance(value.get("gender"), int) else None,
        "age": value.get("age") if isinstance(value.get("age"), int) else None,
        "language": sanitize_text(str(value.get("language") or ""), 40),
        "description": sanitize_text(str(value.get("description") or ""), 500) or None,
        "is_published": value.get("is_published") if isinstance(value.get("is_published"), bool) else None,
    }


def _safe_int(value: object, *, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _optional_bool(value: object) -> bool | None:
    if value is None:
        return None

    if isinstance(value, bool):
        return value

    text = sanitize_text(str(value), 20).lower()

    if text in {"1", "true", "yes", "on"}:
        return True

    if text in {"0", "false", "no", "off"}:
        return False

    return None


def _clean_error(value: str) -> str:
    cleaned = redact_basic_pii(sanitize_text(value, MAX_ERROR_CHARS))
    return cleaned or "camb_error"