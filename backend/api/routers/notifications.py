from __future__ import annotations

from typing import Any
from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from backend.api.dependencies import AuthenticatedRequestContextDep, assert_authenticated

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


class NotificationSettings(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    response_complete: str = "in_app"  # "off", "in_app", "push"
    streak_reminders: str = "off"      # "off", "in_app", "push"
    mood_checkin: str = "off"          # "off", "in_app", "push"


@router.get("/settings", response_model=NotificationSettings)
async def get_notification_settings(
    context: AuthenticatedRequestContextDep,
) -> NotificationSettings:
    assert_authenticated(context)
    return NotificationSettings()


@router.put("/settings", response_model=NotificationSettings)
async def update_notification_settings(
    payload: NotificationSettings,
    context: AuthenticatedRequestContextDep,
) -> NotificationSettings:
    assert_authenticated(context)
    return payload
