# backend/http/notifications.py — Opt-in check-in notifications (Web Push)

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from backend.domain.identity.identity import UserSession, account_guard
from backend.domain.notifications.service import NotificationService

router = APIRouter()
service = NotificationService()


class PushSubscribeRequest(BaseModel):
    endpoint: str = Field(min_length=10, max_length=1000)
    tz_offset: int = Field(default=0, ge=-840, le=840)
    lang: str = Field(default="en", max_length=16)


class PushUnsubscribeRequest(BaseModel):
    endpoint: str = Field(min_length=10, max_length=1000)


@router.get("/api/notifications", operation_id="notificationsStatus")
def notifications_status(
    session: UserSession = Depends(account_guard("use check-in notifications")),
) -> Dict[str, Any]:
    """Whether check-ins can be turned on here, the key to subscribe with, and how many devices have."""
    return service.status(session.user_id_hash)


@router.post("/api/notifications/subscribe", operation_id="notificationsSubscribe")
def notifications_subscribe(
    payload: PushSubscribeRequest,
    session: UserSession = Depends(account_guard("turn on check-in notifications")),
) -> Dict[str, Any]:
    return service.subscribe(session.user_id_hash, payload.endpoint, tz_offset=payload.tz_offset, lang=payload.lang)


@router.post("/api/notifications/unsubscribe", operation_id="notificationsUnsubscribe")
def notifications_unsubscribe(
    payload: PushUnsubscribeRequest,
    session: UserSession = Depends(account_guard("turn off check-in notifications")),
) -> Dict[str, Any]:
    return service.unsubscribe(session.user_id_hash, payload.endpoint)
