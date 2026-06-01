# backend/providers/firebase_provider.py

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from backend.core.config import Settings, get_settings
from backend.core.errors import AuthError, DatabaseError
from backend.core.security import redact_basic_pii, sanitize_text
from backend.services.auth_service import AuthIdentity
from backend.services.db_service import MAX_EVENTS_PER_KIND


MAX_PROJECT_ID_CHARS = 120
MAX_APP_NAME_CHARS = 80
MAX_CREDENTIALS_PATH_CHARS = 1_000
MAX_COLLECTION_CHARS = 80
MAX_DOCUMENT_KEY_CHARS = 180
MAX_ERROR_CHARS = 500


@dataclass(frozen=True, slots=True)
class FirebaseProviderConfig:
    project_id: str | None = None
    credentials_path: str | None = None
    credentials_json: str | None = None
    app_name: str = "mindpal"
    use_application_default: bool = True
    check_revoked_tokens: bool = False

    @classmethod
    def from_settings(cls, settings: Settings | None = None) -> FirebaseProviderConfig:
        settings = settings or get_settings()

        project_id = _optional_text(
            getattr(settings, "FIREBASE_PROJECT_ID", None)
            or getattr(settings, "GOOGLE_CLOUD_PROJECT", None),
            MAX_PROJECT_ID_CHARS,
        )

        credentials_path = _optional_text(
            getattr(settings, "FIREBASE_CREDENTIALS_PATH", None)
            or getattr(settings, "GOOGLE_APPLICATION_CREDENTIALS", None),
            MAX_CREDENTIALS_PATH_CHARS,
        )

        credentials_json = _optional_text(
            getattr(settings, "FIREBASE_CREDENTIALS_JSON", None),
            20_000,
        )

        app_name = (
            _optional_text(getattr(settings, "FIREBASE_APP_NAME", None), MAX_APP_NAME_CHARS)
            or "mindpal"
        )

        return cls(
            project_id=project_id,
            credentials_path=credentials_path,
            credentials_json=credentials_json,
            app_name=app_name,
            use_application_default=bool(
                getattr(settings, "FIREBASE_USE_APPLICATION_DEFAULT", True)
            ),
            check_revoked_tokens=bool(
                getattr(settings, "FIREBASE_CHECK_REVOKED_TOKENS", False)
            ),
        )


class FirebaseProvider:
    """
    Firebase provider implementing both:
    - AuthProvider.verify_bearer_token()
    - DBProvider document/event methods

    Boundary:
    - Firebase SDK imports are lazy.
    - No provider initialization at module import.
    - If firebase_admin or credentials are missing, is_configured=False.
    - Bearer tokens are never stored or returned.
    - Firestore payloads are sanitized before write.
    """

    name = "firebase"

    def __init__(self, config: FirebaseProviderConfig | None = None) -> None:
        self.config = config or FirebaseProviderConfig.from_settings()
        self._app: Any | None = None
        self._firestore_client: Any | None = None
        self._init_lock = asyncio.Lock()
        self._import_error: str | None = None

        try:
            import firebase_admin  # noqa: F401
        except Exception as exc:
            self._import_error = exc.__class__.__name__

    @property
    def is_configured(self) -> bool:
        if self._import_error is not None:
            return False

        return bool(
            self.config.credentials_json
            or self.config.credentials_path
            or self.config.use_application_default
        )

    async def verify_bearer_token(self, token: str) -> AuthIdentity:
        clean_token = sanitize_text(token, 8_000)

        if not clean_token:
            raise AuthError(
                "Firebase token is empty",
                code="firebase_empty_token",
            )

        if not self.is_configured:
            raise AuthError(
                "Firebase provider is not configured",
                code="firebase_not_configured",
                details={"import_error": self._import_error or ""},
            )

        try:
            app = await self._get_app()

            from firebase_admin import auth

            decoded = await asyncio.to_thread(
                auth.verify_id_token,
                clean_token,
                app=app,
                check_revoked=self.config.check_revoked_tokens,
            )

            uid = sanitize_text(str(decoded.get("uid") or ""), 180)

            if not uid:
                raise AuthError(
                    "Firebase token did not contain uid",
                    code="firebase_uid_missing",
                )

            return AuthIdentity(
                raw_user_id=uid,
                provider=self.name,
                email_verified=bool(decoded.get("email_verified", False)),
                metadata=_safe_identity_metadata(decoded),
            )

        except AuthError:
            raise
        except Exception as exc:
            raise AuthError(
                "Firebase token verification failed",
                code="firebase_token_verification_failed",
                details={"error": _clean_error(str(exc))},
            ) from exc

    async def get_document(self, collection: str, key: str) -> dict[str, Any] | None:
        collection = _clean_collection(collection)
        key = _clean_key(key)

        try:
            client = await self._get_firestore_client()
            snapshot = await asyncio.to_thread(
                client.collection(collection).document(key).get
            )

            if not getattr(snapshot, "exists", False):
                return None

            data = snapshot.to_dict()
            return data if isinstance(data, dict) else None

        except Exception as exc:
            raise DatabaseError(
                "Firebase document read failed",
                code="firebase_document_read_failed",
                details={
                    "collection": collection,
                    "provider": self.name,
                    "error": _clean_error(str(exc)),
                },
            ) from exc

    async def set_document(self, collection: str, key: str, payload: dict[str, Any]) -> None:
        collection = _clean_collection(collection)
        key = _clean_key(key)
        safe_payload = _sanitize_payload(payload)

        try:
            client = await self._get_firestore_client()
            await asyncio.to_thread(
                client.collection(collection).document(key).set,
                safe_payload,
                merge=True,
            )

        except Exception as exc:
            raise DatabaseError(
                "Firebase document write failed",
                code="firebase_document_write_failed",
                details={
                    "collection": collection,
                    "provider": self.name,
                    "error": _clean_error(str(exc)),
                },
            ) from exc

    async def delete_document(self, collection: str, key: str) -> None:
        collection = _clean_collection(collection)
        key = _clean_key(key)

        try:
            client = await self._get_firestore_client()
            await asyncio.to_thread(
                client.collection(collection).document(key).delete
            )

        except Exception as exc:
            raise DatabaseError(
                "Firebase document delete failed",
                code="firebase_document_delete_failed",
                details={
                    "collection": collection,
                    "provider": self.name,
                    "error": _clean_error(str(exc)),
                },
            ) from exc

    async def append_event(self, collection: str, payload: dict[str, Any]) -> str:
        collection = _clean_collection(collection)

        try:
            client = await self._get_firestore_client()
            doc_ref = client.collection(collection).document()
            event_id = sanitize_text(str(doc_ref.id), MAX_DOCUMENT_KEY_CHARS)

            event_payload = _sanitize_payload(
                {
                    "event_id": event_id,
                    "created_at": datetime.now(UTC).isoformat(),
                    **payload,
                }
            )

            await asyncio.to_thread(doc_ref.set, event_payload)
            return event_id

        except Exception as exc:
            raise DatabaseError(
                "Firebase event append failed",
                code="firebase_event_append_failed",
                details={
                    "collection": collection,
                    "provider": self.name,
                    "error": _clean_error(str(exc)),
                },
            ) from exc

    async def health(self) -> dict[str, Any]:
        return {
            "provider": self.name,
            "configured": self.is_configured,
            "project_id_present": bool(self.config.project_id),
            "credentials_path_present": bool(self.config.credentials_path),
            "credentials_json_present": bool(self.config.credentials_json),
            "application_default_enabled": self.config.use_application_default,
            "check_revoked_tokens": self.config.check_revoked_tokens,
            "import_error": self._import_error,
        }

    async def _get_firestore_client(self) -> Any:
        if self._firestore_client is not None:
            return self._firestore_client

        app = await self._get_app()

        from firebase_admin import firestore

        self._firestore_client = firestore.client(app=app)
        return self._firestore_client

    async def _get_app(self) -> Any:
        if self._app is not None:
            return self._app

        async with self._init_lock:
            if self._app is not None:
                return self._app

            if not self.is_configured:
                raise DatabaseError(
                    "Firebase provider is not configured",
                    code="firebase_not_configured",
                    details={"import_error": self._import_error or ""},
                )

            self._app = await asyncio.to_thread(self._initialize_app_sync)
            return self._app

    def _initialize_app_sync(self) -> Any:
        import firebase_admin
        from firebase_admin import credentials

        app_name = sanitize_text(self.config.app_name, MAX_APP_NAME_CHARS) or "mindpal"

        try:
            return firebase_admin.get_app(app_name)
        except ValueError:
            pass

        options: dict[str, str] = {}
        if self.config.project_id:
            options["projectId"] = self.config.project_id

        cred: Any | None = None

        if self.config.credentials_json:
            try:
                cert_payload = json.loads(self.config.credentials_json)
            except json.JSONDecodeError as exc:
                raise DatabaseError(
                    "Firebase credentials JSON failed to parse",
                    code="firebase_credentials_json_invalid",
                ) from exc

            cred = credentials.Certificate(cert_payload)

        elif self.config.credentials_path:
            cred = credentials.Certificate(self.config.credentials_path)

        elif self.config.use_application_default:
            cred = credentials.ApplicationDefault()

        return firebase_admin.initialize_app(
            credential=cred,
            options=options or None,
            name=app_name,
        )


def _safe_identity_metadata(decoded: dict[str, Any]) -> dict[str, str | bool | int | float | None]:
    metadata: dict[str, str | bool | int | float | None] = {}

    allowed_keys = {
        "email",
        "email_verified",
        "phone_number",
        "name",
        "picture",
        "firebase",
        "sign_in_provider",
        "auth_time",
        "iat",
        "exp",
        "aud",
        "iss",
    }

    firebase_data = decoded.get("firebase")
    if isinstance(firebase_data, dict):
        sign_in_provider = firebase_data.get("sign_in_provider")
        if sign_in_provider:
            metadata["sign_in_provider"] = sanitize_text(str(sign_in_provider), 120)

    for key in allowed_keys:
        if key == "firebase":
            continue

        value = decoded.get(key)
        if value is None:
            continue

        if key in {"email", "phone_number"}:
            metadata[key] = redact_basic_pii(str(value))
        elif isinstance(value, (bool, int, float)):
            metadata[key] = value
        else:
            metadata[key] = sanitize_text(str(value), 300)

    return metadata


def _sanitize_payload(payload: Any) -> Any:
    if payload is None or isinstance(payload, (bool, int, float)):
        return payload

    if isinstance(payload, str):
        return redact_basic_pii(sanitize_text(payload, 5_000))

    if isinstance(payload, list):
        return [_sanitize_payload(item) for item in payload[:MAX_EVENTS_PER_KIND]]

    if isinstance(payload, dict):
        return {
            sanitize_text(str(key), 120): _sanitize_payload(value)
            for key, value in payload.items()
            if sanitize_text(str(key), 120)
        }

    return redact_basic_pii(sanitize_text(str(payload), 5_000))


def _clean_collection(value: str) -> str:
    cleaned = sanitize_text(str(value or ""), MAX_COLLECTION_CHARS)

    if not cleaned:
        raise DatabaseError(
            "Firebase collection name cannot be empty",
            code="firebase_invalid_collection",
        )

    return cleaned


def _clean_key(value: str) -> str:
    cleaned = sanitize_text(str(value or ""), MAX_DOCUMENT_KEY_CHARS)

    if not cleaned:
        raise DatabaseError(
            "Firebase document key cannot be empty",
            code="firebase_invalid_key",
        )

    return cleaned


def _optional_text(value: object, max_chars: int) -> str | None:
    cleaned = sanitize_text(str(value or ""), max_chars)
    return cleaned or None


def _clean_error(value: str) -> str:
    cleaned = redact_basic_pii(sanitize_text(value, MAX_ERROR_CHARS))
    return cleaned or "firebase_error"