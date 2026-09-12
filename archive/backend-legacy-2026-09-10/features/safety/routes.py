# backend/features/safety/routes.py

"""
Safety verification and policy inspection HTTP endpoints.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

from backend.api.dependencies import RequestContextDep, ServicesDep
from backend.core.security import sanitize_text
from .schemas import SafetyDecision

router = APIRouter(prefix="/api/safety", tags=["safety"])


class SafetyCheckPayload(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    text: str = Field(min_length=1, max_length=4_000)
    locale: str = Field(default="auto", max_length=20)


@router.post("/check", response_model=SafetyDecision)
async def check_message_safety(
    payload: SafetyCheckPayload,
    services: ServicesDep,
    context: RequestContextDep,
) -> SafetyDecision:
    return services.safety.classify_message(payload.text, locale=payload.locale)
