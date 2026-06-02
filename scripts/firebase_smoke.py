from __future__ import annotations

import json
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any

import firebase_admin
from dotenv import load_dotenv
from firebase_admin import credentials, firestore


PROJECT_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(PROJECT_ROOT / ".env", override=False)

COLLECTION_NAME = "_mindpal_smoke_tests"


def _load_credentials() -> credentials.Base:
    raw_json = os.getenv("FIREBASE_CREDENTIALS_JSON", "").strip()
    credentials_path = (
        os.getenv("FIREBASE_CREDENTIALS_PATH", "").strip()
        or os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
    )

    if raw_json:
        try:
            data = json.loads(raw_json)
        except json.JSONDecodeError as exc:
            raise RuntimeError("FIREBASE_CREDENTIALS_JSON is not valid JSON") from exc

        private_key = str(data.get("private_key", ""))
        if "\\n" in private_key:
            data["private_key"] = private_key.replace("\\n", "\n")

        return credentials.Certificate(data)

    if credentials_path:
        path = Path(credentials_path)
        if not path.is_absolute():
            path = PROJECT_ROOT / path

        if not path.exists():
            raise RuntimeError(f"Firebase credentials file not found: {path}")

        return credentials.Certificate(str(path))

    return credentials.ApplicationDefault()


def _get_project_id() -> str:
    project_id = (
        os.getenv("FIREBASE_PROJECT_ID", "").strip()
        or os.getenv("GOOGLE_CLOUD_PROJECT", "").strip()
    )
    if not project_id:
        raise RuntimeError("Missing FIREBASE_PROJECT_ID or GOOGLE_CLOUD_PROJECT")
    return project_id


def _get_database_id() -> str:
    database_id = os.getenv("FIRESTORE_DATABASE_ID", "").strip()
    if not database_id:
        raise RuntimeError("Missing FIRESTORE_DATABASE_ID. Set FIRESTORE_DATABASE_ID=default")
    return database_id


def _init_firebase() -> None:
    app_name = "mindpal-smoke"

    if app_name in firebase_admin._apps:
        return

    firebase_admin.initialize_app(
        _load_credentials(),
        {"projectId": _get_project_id()},
        name=app_name,
    )


def run() -> dict[str, Any]:
    _init_firebase()

    app = firebase_admin.get_app("mindpal-smoke")
    database_id = _get_database_id()
    db = firestore.client(app=app, database_id=database_id)

    doc_id = f"smoke_{uuid.uuid4().hex}"
    ref = db.collection(COLLECTION_NAME).document(doc_id)

    payload = {
        "doc_id": doc_id,
        "service": "mindpal",
        "kind": "firebase_smoke_test",
        "project_id": _get_project_id(),
        "database_id": database_id,
        "created_at_unix": int(time.time()),
        "ok": True,
    }

    ref.set(payload)

    snap = ref.get()
    if not snap.exists:
        raise RuntimeError("Firestore write/read failed: document not found")

    loaded = snap.to_dict() or {}
    if loaded.get("doc_id") != doc_id or loaded.get("ok") is not True:
        raise RuntimeError(f"Firestore data mismatch: {loaded}")

    ref.delete()

    deleted = ref.get()
    if deleted.exists:
        raise RuntimeError("Firestore delete failed: document still exists")

    return {
        "status": "ok",
        "project_id": _get_project_id(),
        "database_id": database_id,
        "collection": COLLECTION_NAME,
        "doc_id": doc_id,
        "write": "ok",
        "read": "ok",
        "delete": "ok",
    }


if __name__ == "__main__":
    try:
        print(json.dumps(run(), ensure_ascii=False, indent=2))
    except Exception as exc:
        print(
            json.dumps(
                {
                    "status": "error",
                    "error": exc.__class__.__name__,
                    "message": str(exc),
                },
                ensure_ascii=False,
                indent=2,
            ),
            file=sys.stderr,
        )
        raise SystemExit(1)
