"""
Infrastructure service builders (Quota, Rate Limit, Idempotency).

These services manage infrastructure concerns like rate limiting,
quotas, and idempotent request handling.
"""

from backend.core.config import Settings
from backend.services.cache_service import CacheService
from backend.services.domain.quota import IdempotencyService, QuotaService, RateLimitService
from backend.services.domain.storage import StorageService as DBService
from backend.services.job_queue_service import AsyncJobQueueService


def build_cache_service(settings: Settings) -> CacheService:
    """Build a cache backend using Redis when configured, otherwise an in-memory fallback."""
    return CacheService(settings=settings)


def build_job_queue_service() -> AsyncJobQueueService:
    """Build an async job queue for background operations and retries."""
    queue = AsyncJobQueueService(max_workers=2, retry_backoff_seconds=1.0)
    return queue


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
