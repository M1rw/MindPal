"""One Firebase Admin app for the whole backend.

Auth verification and the Firestore store both need an initialized Firebase
Admin app. Before this module existed the store initialized it as a side
effect, so removing the store silently broke sign-in: `verify_id_token` fell
back to a default app that was never created and every account was rejected.
Both consumers now ask for the app here.
"""

from __future__ import annotations

import base64
import json
import logging
import threading
from pathlib import Path
from typing import Any, Optional

from backend.configs.settings import get_settings

logger = logging.getLogger("mindpal.firebase")

_LOCK = threading.Lock()
_FAILED_AT: Optional[str] = None
_LOCAL_CREDENTIAL_FILE = Path("firebase-credentials-minified.json")


def _normalize_private_key(data: dict[str, Any]) -> dict[str, Any]:
    private_key = str(data.get("private_key", ""))
    if "\\n" in private_key:
        data = {**data, "private_key": private_key.replace("\\n", "\n")}
    return data


def _credential() -> Any:
    from firebase_admin import credentials

    settings = get_settings()
    raw_b64 = settings.firebase_credentials_base64.strip()
    raw_json = settings.firebase_credentials_json.strip()
    if raw_b64:
        return credentials.Certificate(_normalize_private_key(json.loads(base64.b64decode(raw_b64).decode("utf-8"))))
    if raw_json:
        return credentials.Certificate(_normalize_private_key(json.loads(raw_json)))
    path = settings.firebase_credentials_path.strip() or settings.google_application_credentials.strip()
    if path and Path(path).exists():
        return credentials.Certificate(path)
    if _LOCAL_CREDENTIAL_FILE.exists():
        return credentials.Certificate(str(_LOCAL_CREDENTIAL_FILE))
    return credentials.ApplicationDefault()


def project_id() -> str:
    settings = get_settings()
    return (
        settings.firebase_project_id.strip()
        or settings.firebase_web_project_id.strip()
        or settings.google_cloud_project.strip()
    )


def get_firebase_app() -> Optional[Any]:
    """Return the named Firebase Admin app, initializing it once.

    Returns None when Firebase is disabled or initialization failed; callers
    decide what that means (auth refuses tokens, the store reports degraded).
    """
    settings = get_settings()
    if not settings.enable_firebase:
        return None
    import firebase_admin

    name = settings.firebase_app_name.strip() or "mindpal"
    if name in firebase_admin._apps:
        return firebase_admin.get_app(name)
    with _LOCK:
        if name in firebase_admin._apps:
            return firebase_admin.get_app(name)
        try:
            options = {"projectId": project_id()} if project_id() else None
            app = firebase_admin.initialize_app(_credential(), options, name=name)
        except Exception as exc:
            global _FAILED_AT
            _FAILED_AT = type(exc).__name__
            logger.error("firebase_app_init_failed error=%s detail=%s", type(exc).__name__, str(exc)[:200])
            return None
        logger.info("firebase_app_ready name=%s project=%s", name, project_id() or "(from credential)")
        return app


def firebase_init_error() -> Optional[str]:
    return _FAILED_AT
