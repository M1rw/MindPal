# backend/services/tts_service.py

from __future__ import annotations

import asyncio
import logging
from dataclasses import asdict, dataclass
from typing import Any, Protocol

from backend.core.config import Settings, get_settings
from backend.core.errors import ProviderError, ProviderTimeoutError, ValidationAppError
from backend.core.security import normalize_locale, sanitize_text
from backend.core.settings_helpers import is_production, setting_bool, setting_float, setting_value
from backend.models.schemas import TTSFormat, TTSRequest, TTSResponse

logger = logging.getLogger(__name__)


MAX_TTS_TEXT_CHARS = 4_000
MAX_VOICE_ID_CHARS = 120
MAX_PROVIDER_NAME_CHARS = 80
DEFAULT_TIMEOUT_SECONDS = 20.0


@dataclass(frozen=True, slots=True)
class TTSPolicy:
    locale: str
    voice_id: str | None
    speaking_rate: float
    format: TTSFormat
    browser_fallback_allowed: bool
    external_tts_allowed: bool
    reason: str


@dataclass(frozen=True, slots=True)
class TTSServiceMeta:
    mode: str
    provider_used: str
    fallback_used: bool
    external_attempted: bool
    error_code: str | None = None


class TTSProvider(Protocol):
    """
    TTS provider protocol.

    Camb.ai / ElevenLabs / OpenAI TTS providers should implement this.
    This service intentionally does not import provider SDKs.
    """

    name: str

    @property
    def is_configured(self) -> bool:
        ...

    async def synthesize(self, request: TTSRequest) -> TTSResponse:
        ...


class BrowserFallbackTTSProvider:
    """
    Deterministic browser fallback.

    It returns no audio bytes. The frontend should use Web Speech API or native
    browser/device TTS with the returned text/request context.
    """

    name = "browser"

    @property
    def is_configured(self) -> bool:
        return True

    async def synthesize(self, request: TTSRequest) -> TTSResponse:
        return TTSResponse(
            request_id="tts_browser_fallback",
            provider_used=self.name,
            fallback_to_browser=True,
            mime_type=None,
            audio_url=None,
            audio_base64=None,
            latency_ms=0.0,
        )


class TTSService:
    """
    Text-to-speech orchestration boundary.

    Responsibilities:
    - sanitize text before provider calls
    - pick voice policy from locale/response mode/safety level
    - skip external TTS for crisis/high-risk modes unless explicitly allowed
    - cascade provider failures
    - expose clearly whether backend TTS is real or browser fallback only

    Production policy:
    - browser fallback is acceptable as a frontend fallback, but it is not a
      configured backend TTS provider
    - if REQUIRE_EXTERNAL_TTS_PROVIDER=true, browser fallback alone is not enough
    - high-risk/crisis content does not use external TTS unless explicitly allowed

    Non-responsibilities:
    - generating assistant text
    - safety classification
    - storing audio
    - logging raw text
    """

    def __init__(
        self,
        providers: list[TTSProvider] | tuple[TTSProvider, ...] | None = None,
        *,
        settings: Settings | None = None,
        timeout_seconds: float | None = None,
        include_browser_fallback: bool | None = None,
        require_external_provider: bool | None = None,
        allow_browser_fallback_in_production: bool | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.production_mode = is_production(self.settings)
        self.timeout_seconds = float(
            timeout_seconds
            if timeout_seconds is not None
            else setting_float(
                self.settings,
                "TTS_TIMEOUT_SECONDS",
                default=DEFAULT_TIMEOUT_SECONDS,
            )
        )

        self.require_external_provider = (
            setting_bool(
                self.settings,
                "REQUIRE_EXTERNAL_TTS_PROVIDER",
                default=False,
            )
            if require_external_provider is None
            else bool(require_external_provider)
        )

        self.allow_browser_fallback_in_production = (
            setting_bool(
                self.settings,
                "ALLOW_BROWSER_TTS_IN_PRODUCTION",
                default=True,
            )
            if allow_browser_fallback_in_production is None
            else bool(allow_browser_fallback_in_production)
        )

        should_include_browser_fallback = (
            setting_bool(
                self.settings,
                "ENABLE_BROWSER_TTS_FALLBACK",
                default=True,
            )
            if include_browser_fallback is None
            else bool(include_browser_fallback)
        )

        configured_providers: list[TTSProvider] = list(providers or [])

        if should_include_browser_fallback and not _has_provider(configured_providers, "browser"):
            configured_providers.append(BrowserFallbackTTSProvider())

        if not configured_providers:
            raise ProviderError(
                "TTSService requires at least one provider or browser fallback",
                code="tts_no_providers",
            )

        self._providers = configured_providers
        self.last_meta: TTSServiceMeta | None = None

    @property
    def providers(self) -> tuple[TTSProvider, ...]:
        return tuple(self._providers)

    def build_request(
        self,
        *,
        text: str,
        locale: str = "auto",
        response_mode: str = "normal_support",
        safety_level: str = "safe",
        voice_id: str | None = None,
        format: TTSFormat | str = TTSFormat.MP3,
        speaking_rate: float | None = None,
    ) -> TTSRequest:
        clean_text = sanitize_text(text, MAX_TTS_TEXT_CHARS)

        if not clean_text:
            raise ValidationAppError(
                "TTS text cannot be empty",
                code="tts_empty_text",
            )

        policy = self.select_policy(
            locale=locale,
            response_mode=response_mode,
            safety_level=safety_level,
            voice_id=voice_id,
            format=format,
            speaking_rate=speaking_rate,
        )

        return TTSRequest(
            text=clean_text,
            locale=policy.locale,
            voice_id=policy.voice_id,
            format=policy.format,
            speaking_rate=policy.speaking_rate,
        )

    async def synthesize(
        self,
        request: TTSRequest,
        *,
        response_mode: str = "normal_support",
        safety_level: str = "safe",
        allow_external_for_crisis: bool = False,
    ) -> TTSResponse:
        policy = self.select_policy(
            locale=request.locale,
            response_mode=response_mode,
            safety_level=safety_level,
            voice_id=request.voice_id,
            format=request.format,
            speaking_rate=request.speaking_rate,
            allow_external_for_crisis=allow_external_for_crisis,
        )

        sanitized_request = TTSRequest(
            text=sanitize_text(request.text, MAX_TTS_TEXT_CHARS),
            locale=policy.locale,
            voice_id=policy.voice_id,
            format=policy.format,
            speaking_rate=policy.speaking_rate,
        )

        providers = self._provider_chain(policy)
        external_attempted = False
        fallback_count = 0
        last_error_code: str | None = None

        for provider in providers:
            provider_name = _clean_provider_name(provider.name)
            is_browser = provider_name == "browser"

            if is_browser and not self._browser_fallback_allowed_now():
                fallback_count += 1
                last_error_code = "browser_fallback_disabled"
                continue

            if not provider.is_configured:
                fallback_count += 1
                last_error_code = "provider_not_configured"
                continue

            if not is_browser:
                external_attempted = True

            try:
                response = await asyncio.wait_for(
                    provider.synthesize(sanitized_request),
                    timeout=self.timeout_seconds,
                )

                clean_response = _normalize_tts_response(
                    response,
                    provider_name=provider_name,
                    fallback_to_browser=is_browser,
                )

                self.last_meta = TTSServiceMeta(
                    mode="browser_fallback" if is_browser else "synthesized_external",
                    provider_used=clean_response.provider_used,
                    fallback_used=clean_response.fallback_to_browser,
                    external_attempted=external_attempted,
                    error_code=last_error_code,
                )

                return clean_response

            except asyncio.TimeoutError as exc:
                fallback_count += 1
                last_error_code = "provider_timeout"

                if _is_last_provider(provider, providers):
                    raise ProviderTimeoutError(
                        "All enabled TTS providers timed out",
                        code="tts_all_providers_timeout",
                        details={"last_provider": provider_name},
                    ) from exc

                continue

            except ProviderError as exc:
                fallback_count += 1
                last_error_code = exc.code
                continue

            except asyncio.CancelledError:
                raise

            except Exception:
                logger.warning("TTS provider %s raised unexpected error", provider_name, exc_info=True)
                fallback_count += 1
                last_error_code = "provider_unhandled_error"
                continue

        raise ProviderError(
            "All enabled TTS providers failed",
            code="tts_all_providers_failed",
            details={
                "fallback_count": str(fallback_count),
                "last_error_code": last_error_code or "",
                "require_external_provider": str(self.require_external_provider),
                "browser_fallback_allowed": str(self._browser_fallback_allowed_now()),
            },
        )

    async def synthesize_text(
        self,
        *,
        text: str,
        locale: str = "auto",
        response_mode: str = "normal_support",
        safety_level: str = "safe",
        voice_id: str | None = None,
        format: TTSFormat | str = TTSFormat.MP3,
        speaking_rate: float | None = None,
        allow_external_for_crisis: bool = False,
    ) -> TTSResponse:
        request = self.build_request(
            text=text,
            locale=locale,
            response_mode=response_mode,
            safety_level=safety_level,
            voice_id=voice_id,
            format=format,
            speaking_rate=speaking_rate,
        )

        return await self.synthesize(
            request,
            response_mode=response_mode,
            safety_level=safety_level,
            allow_external_for_crisis=allow_external_for_crisis,
        )

    def select_policy(
        self,
        *,
        locale: str = "auto",
        response_mode: str = "normal_support",
        safety_level: str = "safe",
        voice_id: str | None = None,
        format: TTSFormat | str = TTSFormat.MP3,
        speaking_rate: float | None = None,
        allow_external_for_crisis: bool = False,
    ) -> TTSPolicy:
        resolved_locale = normalize_locale(locale)
        resolved_format = _normalize_format(format)
        resolved_safety = sanitize_text(safety_level or "safe", 80)
        resolved_mode = sanitize_text(response_mode or "normal_support", 80)

        crisis_or_high_risk = resolved_safety in {
            "self_harm_imminent",
            "self_harm_ambiguous",
            "abuse_or_violence",
        }

        external_tts_allowed = not crisis_or_high_risk or allow_external_for_crisis
        browser_fallback_allowed = self._browser_fallback_allowed_now()

        if speaking_rate is None:
            rate = _default_rate_for_mode(resolved_mode, resolved_safety)
        else:
            rate = _clamp_rate(float(speaking_rate))

        selected_voice = sanitize_text(voice_id or "", MAX_VOICE_ID_CHARS) or None

        if selected_voice is None:
            selected_voice = _default_voice_for_locale(resolved_locale, crisis_or_high_risk)

        reason = "default"

        if crisis_or_high_risk:
            reason = "crisis_or_high_risk_neutral_voice"

        if not external_tts_allowed:
            reason = "external_tts_disabled_for_safety"

        if self.require_external_provider and not self._has_configured_external_provider():
            reason = "external_tts_required_but_unavailable"

        return TTSPolicy(
            locale=resolved_locale,
            voice_id=selected_voice,
            speaking_rate=rate,
            format=resolved_format,
            browser_fallback_allowed=browser_fallback_allowed,
            external_tts_allowed=external_tts_allowed,
            reason=reason,
        )

    def health(self) -> dict[str, Any]:
        providers = [
            {
                "name": _clean_provider_name(provider.name),
                "configured": bool(
                    provider.is_configured
                    and _clean_provider_name(provider.name) != "browser"
                ),
                "available": bool(provider.is_configured),
                "browser_fallback": _clean_provider_name(provider.name) == "browser",
            }
            for provider in self._providers
        ]

        external_provider_available = any(
            bool(item["configured"]) and not bool(item["browser_fallback"])
            for item in providers
        )

        browser_fallback_available = any(
            bool(item["available"]) and bool(item["browser_fallback"])
            for item in providers
        )

        return {
            "mode": "provider_chain_with_explicit_browser_fallback",
            "production_mode": self.production_mode,
            "providers": providers,
            "timeout_seconds": self.timeout_seconds,
            "configured_external_provider_available": external_provider_available,
            "external_provider_available": external_provider_available,
            "require_external_provider": self.require_external_provider,
            "browser_fallback_available": browser_fallback_available,
            "browser_fallback_allowed": self._browser_fallback_allowed_now(),
            "allow_browser_fallback_in_production": self.allow_browser_fallback_in_production,
            "external_tts_disabled_by_default_for_crisis": True,
            "last_meta": None if self.last_meta is None else asdict(self.last_meta),
        }

    def _provider_chain(self, policy: TTSPolicy) -> tuple[TTSProvider, ...]:
        external_providers = [
            provider
            for provider in self._providers
            if _clean_provider_name(provider.name) != "browser"
        ]

        browser_providers = [
            provider
            for provider in self._providers
            if _clean_provider_name(provider.name) == "browser"
        ]

        configured_external_providers = [
            provider
            for provider in external_providers
            if bool(provider.is_configured)
        ]

        if policy.external_tts_allowed and configured_external_providers:
            if policy.browser_fallback_allowed:
                return tuple(configured_external_providers + browser_providers)
            return tuple(configured_external_providers)

        if self.require_external_provider:
            raise ProviderError(
                "External TTS provider is required but unavailable",
                code="tts_external_provider_required",
                details={
                    "external_tts_allowed": str(policy.external_tts_allowed),
                    "browser_fallback_allowed": str(policy.browser_fallback_allowed),
                },
            )

        if policy.browser_fallback_allowed and browser_providers:
            return tuple(browser_providers)

        raise ProviderError(
            "No TTS provider available under current policy",
            code="tts_no_safe_provider",
            details={
                "external_tts_allowed": str(policy.external_tts_allowed),
                "browser_fallback_allowed": str(policy.browser_fallback_allowed),
            },
        )

    def _has_configured_external_provider(self) -> bool:
        return any(
            _clean_provider_name(provider.name) != "browser"
            and bool(provider.is_configured)
            for provider in self._providers
        )

    def _browser_fallback_allowed_now(self) -> bool:
        if not _has_provider(list(self._providers), "browser"):
            return False

        if self.production_mode:
            return self.allow_browser_fallback_in_production

        return True


def _normalize_tts_response(
    response: TTSResponse,
    *,
    provider_name: str,
    fallback_to_browser: bool,
) -> TTSResponse:
    return TTSResponse(
        request_id=response.request_id or "tts_response",
        provider_used=response.provider_used or provider_name,
        fallback_to_browser=bool(response.fallback_to_browser or fallback_to_browser),
        mime_type=response.mime_type,
        audio_url=response.audio_url,
        audio_base64=response.audio_base64,
        latency_ms=response.latency_ms,
    )


def _normalize_format(value: TTSFormat | str) -> TTSFormat:
    if isinstance(value, TTSFormat):
        return value

    raw = sanitize_text(str(value or TTSFormat.MP3.value), 20).lower()

    try:
        return TTSFormat(raw)
    except ValueError:
        return TTSFormat.MP3


def _default_rate_for_mode(response_mode: str, safety_level: str) -> float:
    if safety_level in {"self_harm_imminent", "self_harm_ambiguous", "abuse_or_violence"}:
        return 0.88

    if response_mode in {"panic_grounding", "anger_deescalation", "personal_safety"}:
        return 0.9

    if response_mode in {"study_stress", "normal_support"}:
        return 1.0

    return 0.95


def _default_voice_for_locale(locale: str, crisis_or_high_risk: bool) -> str:
    if locale == "ar":
        return "ar-neutral-calm" if crisis_or_high_risk else "ar-balanced"

    if locale == "en":
        return "en-neutral-calm" if crisis_or_high_risk else "en-balanced"

    return "neutral-calm" if crisis_or_high_risk else "balanced"


def _clamp_rate(value: float) -> float:
    return max(0.5, min(float(value), 2.0))


def _has_provider(providers: list[TTSProvider] | tuple[TTSProvider, ...], provider_name: str) -> bool:
    target = _clean_provider_name(provider_name)
    return any(_clean_provider_name(provider.name) == target for provider in providers)


def _clean_provider_name(value: str) -> str:
    cleaned = sanitize_text(str(value or ""), MAX_PROVIDER_NAME_CHARS)
    return cleaned or "unknown"


def _is_last_provider(provider: TTSProvider, providers: tuple[TTSProvider, ...]) -> bool:
    return provider is providers[-1]

