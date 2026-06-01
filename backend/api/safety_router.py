# backend/api/safety_router.py

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.api.dependencies import RequestContextDep, ServicesDep
from backend.core.errors import AppError
from backend.core.security import normalize_locale, sanitize_text
from backend.models.safety import SafetyAction, SafetyDecision, SafetyLevel


router = APIRouter(prefix="/api/safety", tags=["safety"])

MAX_CLASSIFY_TEXT_CHARS = 8_000
MAX_MEMORY_CONTEXT_CHARS = 1_200
MAX_CHANNEL_CHARS = 80
MAX_TEMPLATE_ID_CHARS = 120


class SafetyClassifyPayload(BaseModel):
    """
    Safety classification test payload.

    This is for diagnostics/admin/debug UI. Chat routing must still call
    SafetyService internally before LLM generation.
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    text: str = Field(min_length=1, max_length=MAX_CLASSIFY_TEXT_CHARS)
    locale: str = "auto"
    memory_summary: str | None = Field(default=None, max_length=MAX_MEMORY_CONTEXT_CHARS)
    channel: str | None = Field(default=None, max_length=MAX_CHANNEL_CHARS)

    @field_validator("text", mode="before")
    @classmethod
    def _clean_text(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), MAX_CLASSIFY_TEXT_CHARS)
        if not cleaned:
            raise ValueError("text cannot be empty")
        return cleaned

    @field_validator("locale", mode="before")
    @classmethod
    def _clean_locale(cls, value: object) -> str:
        return normalize_locale(str(value or "auto"))

    @field_validator("memory_summary", "channel", mode="before")
    @classmethod
    def _clean_optional_text(cls, value: object) -> object:
        if value is None:
            return None
        cleaned = sanitize_text(str(value), MAX_MEMORY_CONTEXT_CHARS)
        return cleaned or None


class SafetyClassifyResponse(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    request_id: str
    level: SafetyLevel
    action: SafetyAction
    bypass_llm: bool
    should_log: bool
    response_template_id: str | None
    matched_rules: list[str]
    user_visible_category: str
    confidence: float
    rationale: str
    rag_tags: list[str]
    deterministic_response: str | None = None
    classifier_meta: dict[str, Any] | None = None


class CrisisResponsePayload(BaseModel):
    """
    Deterministic crisis response template renderer.

    This endpoint renders approved templates only. It does not call an LLM.
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    template_id: str | None = Field(default=None, max_length=MAX_TEMPLATE_ID_CHARS)
    locale: str = "auto"

    @field_validator("template_id", mode="before")
    @classmethod
    def _clean_template_id(cls, value: object) -> object:
        if value is None:
            return None
        cleaned = sanitize_text(str(value), MAX_TEMPLATE_ID_CHARS)
        return cleaned or None

    @field_validator("locale", mode="before")
    @classmethod
    def _clean_locale(cls, value: object) -> str:
        return normalize_locale(str(value or "auto"))


class CrisisResponseTemplateView(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    request_id: str
    template_id: str
    locale: str
    title: str
    body: str


@router.post("/classify", response_model=SafetyClassifyResponse)
async def classify_safety(
    payload: SafetyClassifyPayload,
    services: ServicesDep,
    context: RequestContextDep,
) -> SafetyClassifyResponse:
    """
    Classify text with the same safety service used by chat_router.

    This endpoint does not generate assistant replies except deterministic
    crisis template text when bypass_llm=true.
    """
    try:
        locale = payload.locale if payload.locale != "auto" else context.locale

        decision = await services.safety.classify_input_with_context(
            payload.text,
            locale=locale,
            memory_summary=payload.memory_summary,
            channel=payload.channel or context.channel.value,
        )

        deterministic_response = None
        if decision.bypass_llm:
            deterministic_response = services.safety.render_deterministic_response(
                decision,
                locale,
            )

        return _classification_response(
            request_id=context.request_id,
            decision=decision,
            deterministic_response=deterministic_response,
            rag_tags=services.safety.rag_tags_for_decision(decision),
            classifier_meta=services.safety.health().get("last_meta"),
        )

    except AppError as exc:
        raise _http_error_from_app_error(exc) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "safety_classification_failed",
                "message": "Failed to classify safety state",
                "request_id": context.request_id,
            },
        ) from exc


@router.post("/render-crisis-response", response_model=CrisisResponseTemplateView)
async def render_crisis_response(
    payload: CrisisResponsePayload,
    services: ServicesDep,
    context: RequestContextDep,
) -> CrisisResponseTemplateView:
    """
    Render a deterministic crisis response template.

    This is intentionally template-only and never calls LLM providers.
    """
    try:
        locale = payload.locale if payload.locale != "auto" else context.locale
        template = services.safety.get_crisis_response_template(
            payload.template_id,
            locale,
        )

        return CrisisResponseTemplateView(
            request_id=context.request_id,
            template_id=template.template_id,
            locale=template.locale,
            title=template.title,
            body=template.body,
        )

    except AppError as exc:
        raise _http_error_from_app_error(exc) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "crisis_template_render_failed",
                "message": "Failed to render crisis response template",
                "request_id": context.request_id,
            },
        ) from exc


@router.get("/health")
async def safety_health(
    services: ServicesDep,
    context: RequestContextDep,
) -> dict[str, Any]:
    """
    Safety subsystem health.

    Does not expose raw regex patterns, raw YAML, or private user text.
    """
    health = services.safety.health()

    return {
        "request_id": context.request_id,
        "safety": {
            "mode": health["mode"],
            "rules_loaded": health["rules_loaded"],
            "exclusion_rules_loaded": health["exclusion_rules_loaded"],
            "templates_loaded": health["templates_loaded"],
            "fallback_templates_loaded": health["fallback_templates_loaded"],
            "locales": health["locales"],
            "llm_ambiguity_classifier_enabled": health["llm_ambiguity_classifier_enabled"],
            "llm_service_available": health["llm_service_available"],
            "imminent_self_harm_bypasses_llm": health["imminent_self_harm_bypasses_llm"],
            "last_meta": health.get("last_meta"),
        },
    }


def _classification_response(
    *,
    request_id: str,
    decision: SafetyDecision,
    deterministic_response: str | None,
    rag_tags: list[str],
    classifier_meta: dict[str, Any] | None,
) -> SafetyClassifyResponse:
    return SafetyClassifyResponse(
        request_id=request_id,
        level=decision.level,
        action=decision.action,
        bypass_llm=decision.bypass_llm,
        should_log=decision.should_log,
        response_template_id=decision.response_template_id,
        matched_rules=decision.matched_rules,
        user_visible_category=decision.user_visible_category,
        confidence=decision.confidence,
        rationale=decision.rationale,
        rag_tags=rag_tags,
        deterministic_response=deterministic_response,
        classifier_meta=classifier_meta,
    )


def _http_error_from_app_error(exc: AppError) -> HTTPException:
    status_code = getattr(exc, "status_code", None) or status.HTTP_500_INTERNAL_SERVER_ERROR
    code = getattr(exc, "code", None) or exc.__class__.__name__
    message = sanitize_text(str(exc), 500) or "Application error"
    details = getattr(exc, "details", None) or {}

    return HTTPException(
        status_code=status_code,
        detail={
            "code": code,
            "message": message,
            "details": details,
        },
    )