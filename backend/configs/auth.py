from __future__ import annotations

from typing import Any

from .settings import get_settings

FIREBASE_ENV_KEYS = {
    "api_key": "FIREBASE_WEB_API_KEY",
    "project_id": "FIREBASE_WEB_PROJECT_ID",
    "auth_domain": "FIREBASE_AUTH_DOMAIN",
    "storage_bucket": "FIREBASE_STORAGE_BUCKET",
    "messaging_sender_id": "FIREBASE_MESSAGING_SENDER_ID",
    "app_id": "FIREBASE_WEB_APP_ID",
    "measurement_id": "FIREBASE_MEASUREMENT_ID",
    "google_client_id": "FIREBASE_WEB_GOOGLE_CLIENT_ID",
    "app_check_site_key": "FIREBASE_APPCHECK_SITE_KEY",
    "enable_firebase": "ENABLE_FIREBASE",
    "firebase_project_id": "FIREBASE_PROJECT_ID",
    "google_cloud_project": "GOOGLE_CLOUD_PROJECT",
    "firebase_api_key": "FIREBASE_API_KEY",
    "firebase_app_id": "FIREBASE_APP_ID",
}


def firebase_public_bootstrap() -> dict[str, Any]:
    return get_settings().firebase_public_bootstrap()
