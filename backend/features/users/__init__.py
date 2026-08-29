# backend/features/users/__init__.py

"""
Users and authentication feature public exports.
"""

from .admin_authority import AdminAuthority, AlwaysAllowAdminAuthority, DefaultAdminAuthority
from .auth_service import AuthIdentity, AuthProvider, AuthResolutionMeta, AuthService, FirebaseAuthProvider
from .routes import CurrentUserResponse, UserProfileResponse, router
from .schemas import (
    CommunicationStyle,
    UserChannel,
    UserPreferences,
    UserProfile,
    UserProfileUpdate,
    UserSafetyPreference,
    UserSession,
    UserStatus,
)

__all__ = [
    "AdminAuthority",
    "AlwaysAllowAdminAuthority",
    "AuthIdentity",
    "AuthProvider",
    "AuthResolutionMeta",
    "AuthService",
    "CommunicationStyle",
    "CurrentUserResponse",
    "DefaultAdminAuthority",
    "FirebaseAuthProvider",
    "UserChannel",
    "UserPreferences",
    "UserProfile",
    "UserProfileResponse",
    "UserProfileUpdate",
    "UserSafetyPreference",
    "UserSession",
    "UserStatus",
    "router",
]
