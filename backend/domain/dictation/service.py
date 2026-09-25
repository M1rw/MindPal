"""Composer dictation: a voice note in, text in the person's own languages out.

Separate from chat credits (a dictated message is sent, and paid for, as a
chat message), but not unlimited: each account, or each network for guests,
gets an hourly allowance, because every transcription is a provider call.
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional, Sequence

from backend.configs.runtime import api_limits_config
from backend.core.errors import AppError
from backend.infra.llm.transcribe import TranscriptionUnavailable, transcribe_audio, transcription_available
from backend.infra.store.store import StoreUnavailable, get_store

_LIMITS = api_limits_config()["dictation"]
MAX_AUDIO_BYTES = int(_LIMITS["max_audio_bytes"])
_COLLECTION = "dictation_rate"
_ACCEPTED = ("audio/webm", "audio/ogg", "audio/mp4", "audio/aac", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp3")


@dataclass(frozen=True)
class DictationResult:
    text: str
    language: str


def accepted_content_type(content_type: str) -> bool:
    return content_type.split(";", 1)[0].strip().lower() in _ACCEPTED


class DictationService:
    def __init__(self, store: Any = None, clock: Any = time.time) -> None:
        self._store = store
        self._clock = clock

    @property
    def store(self) -> Any:
        return self._store if self._store is not None else get_store()

    def available(self) -> bool:
        return transcription_available()

    def _take_allowance(self, subject: str, per_hour: int) -> bool:
        hour = int(self._clock() // 3600)
        doc_id = hashlib.sha256(f"{subject}:{hour}".encode("utf-8")).hexdigest()[:40]

        def mutate(current: Optional[Dict[str, Any]], write: Any) -> bool:
            used = int((current or {}).get("used", 0))
            if used >= per_hour:
                return False
            write({"used": used + 1, "expires_at": (hour + 2) * 3600})
            return True

        try:
            return bool(self.store.transact(_COLLECTION, doc_id, mutate))
        except StoreUnavailable:
            # The limit fails closed with the store, like chat credits.
            raise AppError("unavailable", "Dictation is briefly unavailable. Please try again.")

    def transcribe(
        self,
        audio: bytes,
        content_type: str,
        *,
        subject: str,
        signed_in: bool,
        languages: Sequence[str] = (),
    ) -> DictationResult:
        if not audio:
            raise AppError("payload_invalid", "No audio was received.")
        if len(audio) > MAX_AUDIO_BYTES:
            raise AppError("payload_invalid", "That recording is too long to transcribe. Try a shorter one.")
        if not accepted_content_type(content_type):
            raise AppError("payload_invalid", "Unsupported audio format.")
        if not self.available():
            raise AppError("unavailable", "Dictation isn't available right now.")
        per_hour = int(_LIMITS["per_hour_account" if signed_in else "per_hour_guest"])
        if not self._take_allowance(subject, per_hour):
            raise AppError("rate_limited", "You've dictated a lot this hour. Typing still works, and dictation is back soon.")
        try:
            transcript = transcribe_audio(audio, content_type, languages)
        except TranscriptionUnavailable:
            raise AppError("unavailable", "Dictation couldn't transcribe that. Please try again.")
        return DictationResult(text=transcript.text, language=transcript.language)
