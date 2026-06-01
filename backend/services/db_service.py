import os
import logging
import asyncio
from typing import Optional, Dict, Any, List
from datetime import datetime, timezone

import firebase_admin
from firebase_admin import credentials, firestore

from core.config import settings
from models.schemas import MessageTurn

logger = logging.getLogger("mindpal_db")
logger.setLevel(logging.INFO)

# Global DB client reference
_db_client = None

def initialize_db():
    """
    Initializes the Firebase Admin SDK on application startup.
    Fails gracefully into a 'Mock Mode' if credentials are missing.
    """
    global _db_client
    
    if not settings.FIREBASE_CREDENTIALS_PATH or not os.path.exists(settings.FIREBASE_CREDENTIALS_PATH):
        logger.warning("FIREBASE_CREDENTIALS_PATH missing or invalid. DB Service running in MOCK mode (No data will be saved).")
        return

    try:
        if not firebase_admin._apps:
            cred = credentials.Certificate(settings.FIREBASE_CREDENTIALS_PATH)
            firebase_admin.initialize_app(cred)
        
        _db_client = firestore.client()
        logger.info("Firebase Admin SDK initialized successfully.")
    except Exception as e:
        logger.error(f"Failed to initialize Firebase Admin SDK: {e}")
        _db_client = None

# Run initialization immediately when the module is imported by FastAPI
initialize_db()

# --- ASYNC DATABASE OPERATIONS ---
# We use asyncio.to_thread() to offload synchronous Firestore network calls 
# to a background thread pool. This prevents FastAPI's event loop from blocking.

async def get_user_long_term_summary(user_id: str) -> Optional[str]:
    """Fetches the user's compressed psychological summary."""
    if not _db_client:
        return None
        
    def _fetch():
        doc_ref = _db_client.collection("users").document(user_id)
        doc = doc_ref.get()
        if doc.exists:
            return doc.to_dict().get("long_term_summary")
        return None
        
    try:
        return await asyncio.to_thread(_fetch)
    except Exception as e:
        logger.error(f"DB Fetch Error (get_user_long_term_summary): {e}")
        return None

async def save_user_long_term_summary(user_id: str, summary: str) -> bool:
    """Saves or updates the user's compressed psychological summary."""
    if not _db_client:
        return False
        
    def _save():
        doc_ref = _db_client.collection("users").document(user_id)
        # Use merge=True so we don't accidentally overwrite other profile fields (like streaks)
        doc_ref.set({"long_term_summary": summary, "last_updated": firestore.SERVER_TIMESTAMP}, merge=True)
        
    try:
        await asyncio.to_thread(_save)
        return True
    except Exception as e:
        logger.error(f"DB Save Error (save_user_long_term_summary): {e}")
        return False

async def log_crisis_event(user_id: str, message: str, flag_reason: str) -> bool:
    """
    Securely logs an intercepted crisis event for admin observability.
    Critical for clinical compliance and safety audits.
    """
    if not _db_client:
        return False
        
    def _log():
        doc_ref = _db_client.collection("crisis_logs").document()
        doc_ref.set({
            "user_id": user_id,
            "message": message,
            "flag_reason": flag_reason,
            "timestamp": firestore.SERVER_TIMESTAMP,
            "resolved": False
        })
        
    try:
        await asyncio.to_thread(_log)
        return True
    except Exception as e:
        logger.error(f"DB Crisis Log Error: {e}")
        return False

async def backup_chat_turn(user_id: str, user_message: str, ai_response: str, mode: str) -> bool:
    """
    Backs up a single interaction turn to the user's secure history subcollection.
    """
    if not _db_client:
        return False
        
    def _backup():
        collection_ref = _db_client.collection("users").document(user_id).collection("chat_history")
        collection_ref.add({
            "user_message": user_message,
            "ai_response": ai_response,
            "mode": mode,
            "timestamp": firestore.SERVER_TIMESTAMP
        })
        
    try:
        await asyncio.to_thread(_backup)
        return True
    except Exception as e:
        logger.error(f"DB Backup Error (backup_chat_turn): {e}")
        return False