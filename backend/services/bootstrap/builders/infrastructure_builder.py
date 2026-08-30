"""
Infrastructure service builders (Quota, Rate Limit, Idempotency).

These services manage infrastructure concerns like rate limiting,
quotas, and idempotent request handling.
"""

from backend.core.config import Settings
from backend.services import DBService
from backend.services.idempotency_service import IdempotencyService
from backend.services.quota_service import QuotaService
from backend.services.rate_limit_service import RateLimitService


def build_quota_service(db: DBService, settings: Settings) -> QuotaService:
    """
    Construct quota service.

    Args:
        db: Database service
        settings: Application settings

    Returns:
        QuotaService instance
    """
    return QuotaService(
        db=db,
        limit_5h=settings.QUOTA_LIMIT_5H,
        limit_week=settings.QUOTA_LIMIT_WEEK,
        reservation_ttl_seconds=settings.QUOTA_RESERVATION_TTL_SECONDS,
    )


def build_rate_limits_service(db: DBService) -> RateLimitService:
    """
    Construct rate limit service.

    Args:
        db: Database service

    Returns:
        RateLimitService instance
    """
    return RateLimitService(db=db)


def build_idempotency_service(db: DBService, settings: Settings) -> IdempotencyService:
    """
    Construct idempotency service.

    Args:
        db: Database service
        settings: Application settings

    Returns:
        IdempotencyService instance
    """
    return IdempotencyService(
        db=db,
        ttl_seconds=settings.IDEMPOTENCY_TTL_SECONDS,
        processing_timeout_seconds=settings.IDEMPOTENCY_PROCESSING_TIMEOUT_SECONDS,
    )
