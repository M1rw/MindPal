# backend/domain/voice/summarize.py — Post-call recap into chat history

from __future__ import annotations

import logging
import re
import time
from datetime import datetime, timezone
from typing import Any, Dict

from backend.configs.runtime import voice_runtime_config
from backend.configs.voice import VOICE_SUMMARY_SYSTEM
from backend.core.errors import AppError
from backend.domain.memory.extract import can_persist_user_memory, extract_atoms_from_transcript
from backend.domain.memory.graph import MemoryGraphService, format_memory_receipt
from backend.domain.voice.runtime.records import save_session_record
from backend.domain.voice.services.session import (
    VOICE_SESSION_COLLECTION,
    VoiceSessionService,
)
from backend.infra.llm.gateway import LLMGateway, LLMGatewayError

logger = logging.getLogger("mindpal.voice")

CHAT_COLLECTION = "chat_sessions"
_SUMMARY_CONFIG = voice_runtime_config()["summary"]
LEDGER_CHARS = int(_SUMMARY_CONFIG["ledger_chars"])
MIN_SPEECH_WORDS = int(_SUMMARY_CONFIG["min_speech_words"])
MAX_SUMMARY_WORDS = int(_SUMMARY_CONFIG["max_summary_words"])
SYSTEM_PROMPT = VOICE_SUMMARY_SYSTEM


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _cap(text: Any, limit: int = LEDGER_CHARS) -> str:
    value = " ".join(str(text or "").split())
    if len(value) <= limit:
        return value
    tail = value[-limit:]
    cut = tail.find(" ")
    return tail[cut + 1 :] if cut > 0 else tail


def _words(text: str) -> int:
    return len(re.findall(r"\S+", text or ""))


def _duration_label(used_s: int) -> str:
    seconds = max(0, int(used_s or 0))
    if seconds < 45:
        return "a short call"
    minutes = max(1, round(seconds / 60))
    return f"{minutes} min"


def _pick_transcripts(record: Dict[str, Any], user_text: str, ai_text: str) -> tuple[str, str]:
    stored_user = _cap(record.get("input_ledger") or record.get("input_transcript"))
    stored_ai = _cap(record.get("output_ledger") or record.get("output_transcript"))
    inbound = _cap(user_text) or stored_user
    outbound = _cap(ai_text) or stored_ai
    if len(stored_user) > len(inbound):
        inbound = stored_user
    if len(stored_ai) > len(outbound):
        outbound = stored_ai
    return inbound, outbound


def _is_crisis(record: Dict[str, Any]) -> bool:
    return (
        record.get("status") in {"crisis_freeze", "stay_support", "speak_then_pause"}
        or record.get("floor") == "crisis_freeze"
        or bool(record.get("inhibit_memory"))
        or bool(record.get("stay_support"))
        or str(record.get("teardown_reason") or "") in {
            "crisis_freeze",
            "escalate_pause",
            "speak_then_pause",
            "unverified_safety",
        }
    )


def _format_receipt(summary: str, used_s: int) -> str:
    del used_s
    body = " ".join(str(summary or "").split())
    return (
        f"{body}\n\n"
        "This is a recap of what was said on the call, not a clinical note."
    )


class VoiceSummarizeService:
    """Turn a finished live call into one honest chat receipt."""

    def __init__(
        self,
        *,
        session_service: VoiceSessionService | None = None,
        store: Any | None = None,
        gateway: LLMGateway | None = None,
        memory_service: MemoryGraphService | None = None,
    ) -> None:
        self.session_service = session_service or VoiceSessionService()
        self.store = store or self.session_service.store
        self.gateway = gateway or LLMGateway()
        self.memory_service = memory_service or MemoryGraphService(self.store)

    def owned_record(self, *, user_id_hash: str, session_id: str) -> Dict[str, Any]:
        sid = str(session_id or "").strip()
        if not sid:
            raise AppError("payload_invalid", "A live voice recap needs a session_id.")
        record = self.store.get_document(VOICE_SESSION_COLLECTION, sid)
        if not record or record.get("user_id_hash") != user_id_hash:
            raise AppError("not_found", "That live voice session is not available.")
        return record

    async def generate(self, prompt: str) -> str:
        # 90 output tokens is a compact recap budget (under 35 words). With 2.5
        # thinking on, thoughts are counted against max_output_tokens and this
        # call returns empty text -> "A recap could not be written". Summarising
        # a transcript we already hold needs no thinking.
        return await self.gateway.generate(
            prompt=prompt,
            system_instruction=SYSTEM_PROMPT,
            temperature=0.3,
            max_tokens=90,
            thinking_budget=0,
        )

    async def summarize(
        self,
        *,
        user_id_hash: str,
        session_id: str,
        chat_session_id: str = "",
        user_transcript: str = "",
        ai_transcript: str = "",
    ) -> Dict[str, Any]:
        record = self.owned_record(user_id_hash=user_id_hash, session_id=session_id)
        if record.get("summary_message"):
            result: Dict[str, Any] = {
                "skipped": False,
                "reason": "already_written",
                "summary": record.get("summary_text") or "",
                "message": record["summary_message"],
            }
            if record.get("memory_receipt"):
                result["memory"] = record["memory_receipt"]
            return result

        if _is_crisis(record):
            return self._skip(record, "crisis_handoff")

        inbound, outbound = _pick_transcripts(record, user_transcript, ai_transcript)
        record["input_ledger"] = inbound
        record["output_ledger"] = outbound
        if _words(inbound) + _words(outbound) < MIN_SPEECH_WORDS:
            return self._skip(record, "no_speech")

        used_s = int(record.get("used_s") or 0)
        if used_s <= 0:
            used_s = self.session_service._elapsed_s(record)

        try:
            summary = self._clean_summary(await self.generate(self._prompt(inbound, outbound)))
        except LLMGatewayError:
            logger.warning("voice_summarize_llm_failed session_id=%s", session_id)
            summary = (
                f"You had a live voice call ({_duration_label(used_s)}). "
                "A recap of what was said could not be written."
            )
        except Exception:
            logger.warning("voice_summarize_failed session_id=%s", session_id, exc_info=True)
            summary = (
                f"You had a live voice call ({_duration_label(used_s)}). "
                "A recap of what was said could not be written."
            )

        if not summary:
            return self._skip(record, "no_speech")

        # The model call can take seconds; the account's data may have been
        # deleted meanwhile. Nothing below may write for a session that is gone.
        if self.store.get_document(VOICE_SESSION_COLLECTION, session_id) is None:
            logger.info("voice_summarize_dropped_session_deleted session_id=%s", session_id)
            return {"skipped": True, "reason": "session_deleted"}

        # Extract durable memory atoms from user speech during call
        memory_receipt: Dict[str, Any] | None = None
        if inbound and not _is_crisis(record):
            try:
                atoms = extract_atoms_from_transcript(inbound)
                if atoms:
                    if can_persist_user_memory(user_id_hash):
                        _graph, saved = self.memory_service.merge_atoms(user_id_hash, atoms)
                        memory_receipt = format_memory_receipt(saved)
                        logger.info(
                            "voice_call_memory_persisted session_id=%s atoms=%s",
                            session_id,
                            memory_receipt["count"],
                        )
                    else:
                        memory_receipt = format_memory_receipt(atoms)
                        logger.info(
                            "voice_call_memory_guest session_id=%s atoms=%s",
                            session_id,
                            memory_receipt["count"],
                        )
            except Exception:
                logger.warning("voice_call_memory_extract_failed session_id=%s", session_id, exc_info=True)

        message = {
            "id": f"voice-{session_id}",
            "role": "assistant",
            "kind": "voice_receipt",
            "content": _format_receipt(summary, used_s),
            "timestamp": _now_iso(),
            "voice_used_s": used_s,
        }
        record["summary_text"] = summary
        record["summary_message"] = message
        record["summarized_at"] = time.time()
        for field in ("input_transcript", "output_transcript", "input_ledger", "output_ledger", "working_memory"):
            record.pop(field, None)
        if memory_receipt:
            record["memory_receipt"] = memory_receipt
        # Saved before anything else is written, and never recreated: if the
        # account's data was deleted while the model was writing this recap,
        # the session is gone and so must be the receipt and memory digest.
        # Writing them anyway brought deleted data back after a success response.
        if save_session_record(self.store, session_id, record) is None:
            logger.info("voice_summarize_dropped_session_deleted session_id=%s", session_id)
            return {"skipped": True, "reason": "session_deleted"}
        self._append_chat(user_id_hash, str(chat_session_id or "").strip(), message)
        logger.info("voice_summarize_written session_id=%s chat_present=%s", session_id, bool(chat_session_id))
        recap_failed = summary.endswith("A recap of what was said could not be written.")
        if can_persist_user_memory(user_id_hash) and not recap_failed:
            # The recap already cost an AI call; reusing it as a memory digest is free.
            try:
                from backend.domain.memory.consolidation import MemoryConsolidationService

                MemoryConsolidationService(self.store, memory=self.memory_service).add_digest(
                    user_id_hash, f"In a voice call: {summary}", source="voice"
                )
            except Exception:
                logger.warning("voice_recap_digest_skipped session_id=%s", session_id)
        response: Dict[str, Any] = {"skipped": False, "summary": summary, "message": message}
        if memory_receipt and memory_receipt.get("saved"):
            response["memory"] = memory_receipt
        return response

    def _skip(self, record: Dict[str, Any], reason: str) -> Dict[str, Any]:
        record["summary_skipped"] = reason
        save_session_record(self.store, str(record.get("session_id") or ""), record)
        return {"skipped": True, "reason": reason}

    def _prompt(self, inbound: str, outbound: str) -> str:
        return (
            "Transcript of a finished live voice call. Recap only what is here.\n\n"
            f"User:\n{inbound}\n\n"
            f"MindPal:\n{outbound or '(no assistant transcript)'}"
        )

    def _clean_summary(self, text: str) -> str:
        value = " ".join(str(text or "").split())
        stub = "i'm here with you. what's on your mind?"
        if not value or value.lower() == stub:
            return ""
        words = value.split()
        if len(words) > MAX_SUMMARY_WORDS:
            value = " ".join(words[:MAX_SUMMARY_WORDS])
        return value

    def _append_chat(self, user_id_hash: str, chat_session_id: str, message: Dict[str, Any]) -> None:
        if not chat_session_id:
            return
        now = message["timestamp"]
        doc_id = f"{user_id_hash}:{chat_session_id}"
        doc = self.store.get_document(CHAT_COLLECTION, doc_id) or {
            "id": chat_session_id,
            "title": "New chat",
            "createdAt": now,
            "updatedAt": now,
            "messages": [],
            "user_id_hash": user_id_hash,
        }
        messages = list(doc.get("messages") or [])
        if any(str(row.get("id") or "") == message["id"] for row in messages):
            for index, row in enumerate(messages):
                if str(row.get("id") or "") == message["id"]:
                    messages[index] = {**row, **message}
            doc["messages"] = messages
            doc["updatedAt"] = now
            self.store.set_document(CHAT_COLLECTION, doc_id, doc)
            return
        messages.append(message)
        doc["messages"] = messages
        doc["updatedAt"] = now
        doc["user_id_hash"] = user_id_hash
        doc["id"] = chat_session_id
        doc["createdAt"] = doc.get("createdAt") or now
        if not str(doc.get("title") or "").strip():
            doc["title"] = "New chat"
        self.store.set_document(CHAT_COLLECTION, doc_id, doc)
