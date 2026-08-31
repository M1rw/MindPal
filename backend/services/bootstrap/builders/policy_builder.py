"""
Feature policy and admin authority builders.

These build the configuration and authorization infrastructure.
"""

import httpx

from backend.core.config import Settings
from backend.core.errors import ConfigError
from backend.services.domain.admin import AdminAuthority, SupabaseAdminRepository
from backend.services.domain.features import (
    FeaturePolicyRepository,
    FeaturePolicyStore,
    SupabaseFeaturePolicyRepository,
)
from backend.services.domain.storage import StorageService as DBService
from backend.services.supabase_client import SupabaseClient


def build_feature_policy_store(
    settings: Settings, db: DBService, http_client: httpx.AsyncClient
) -> FeaturePolicyStore:
    """
    Construct feature policy store (Firestore or Supabase).

    Determines storage backend based on settings.FEATURE_POLICY_STORAGE.

    Args:
        settings: Application settings
        db: Database service (for Firestore backend)
        http_client: Shared HTTP client (for Supabase backend)

    Returns:
        FeaturePolicyStore instance

    Raises:
        ConfigError: If storage backend is not properly configured
    """
    if settings.FEATURE_POLICY_STORAGE == "firestore":
        return FeaturePolicyRepository(db=db)

    service_role_key = (
        settings.SUPABASE_SERVICE_ROLE_KEY.get_secret_value()
        if settings.SUPABASE_SERVICE_ROLE_KEY is not None
        else ""
    )
    if not settings.SUPABASE_URL.strip() or not service_role_key:
        raise ConfigError(
            "Supabase feature-policy storage requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY",
            code="supabase_config_missing",
        )

    return SupabaseFeaturePolicyRepository(
        client=SupabaseClient(
            base_url=settings.SUPABASE_URL,
            service_role_key=service_role_key,
            http_client=http_client,
        )
    )


def build_admin_authority(
    settings: Settings, http_client: httpx.AsyncClient
) -> AdminAuthority:
    """
    Construct admin authority (Firestore or Supabase).

    Determines authorization backend based on settings.FEATURE_POLICY_STORAGE.

    Args:
        settings: Application settings
        http_client: Shared HTTP client (for Supabase backend)

    Returns:
        AdminAuthority instance

    Raises:
        ConfigError: If authorization backend is not properly configured
    """
    if settings.FEATURE_POLICY_STORAGE == "firestore":
        return AdminAuthority()

    service_role_key = (
        settings.SUPABASE_SERVICE_ROLE_KEY.get_secret_value()
        if settings.SUPABASE_SERVICE_ROLE_KEY is not None
        else ""
    )
    if not settings.SUPABASE_URL.strip() or not service_role_key:
        raise ConfigError(
            "Supabase admin authority requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY",
            code="supabase_config_missing",
        )

    return AdminAuthority(
        repository=SupabaseAdminRepository(
            client=SupabaseClient(
                base_url=settings.SUPABASE_URL,
                service_role_key=service_role_key,
                http_client=http_client,
            )
        )
    )
