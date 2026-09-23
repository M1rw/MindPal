# backend/domain/voice/session.py — Live session graph, reservation, floor events

from __future__ import annotations

import logging
import time
import uuid
from dataclasses import asdict
from typing import Any, Dict, Optional

from backend.configs.runtime import voice_runtime_settings
from backend.configs.settings import get_settings
from backend.core.errors import AppError
from backend.domain.flags.engine import FeatureLifecycleEngine
from backend.domain.safety.modes.chat.classify import CRISIS_RESPONSE
from backend.domain.safety.modes.voice.classify import (
    DANGER_UNSPECIFIED,
    DISTRESS_SUPPORT,
    IMMINENT_ESCALATE,
    STAY_SUPPORT_NOTE,
    VoiceCrisisClassifier,
    pause_body,
    situation_nudge,
    speak_then_pause_note,
)
from backend.domain.adaptation.profile import (
    AdaptiveProfileService,
    merge_learned_personalization,
    personalization_overrides,
    preference_note,
)
from backend.domain.memory.graph import MemoryGraphService
from backend.domain.voice.policy import resolve_voice_policy
from backend.domain.voice.providers.gemini.budget import get_gemini_call_budget, should_run_classify
from backend.domain.voice.providers.gemini.live import GeminiLiveVoiceProvider
from backend.domain.voice.providers.live import LiveVoiceProvider
from backend.domain.voice.runtime.idempotency import VoiceEventIdempotency
from backend.domain.voice.telemetry import VOICE_TELEMETRY_RETENTION_S, VoiceTelemetryService
from backend.domain.voice.runtime.transcript import (
    append as _append,
    compact_working_memory as _compact_working_memory,
    speech_delta as _speech_delta,
    window as _window,
)
from backend.domain.voice.runtime.usage import RECLAIM_REASONS, VoiceUsageLifecycle
from backend.domain.voice.services.token import (
    LEARNED_NOTE_KEY,
    MEMORY_NOTE_KEY,
    SERVER_ONLY_KEYS,
    TOKEN_TTL_SECONDS,
    VoiceTokenService,
    live_model_id,
    live_voice_id,
)
from backend.infra.store.store import get_store, store_is_durable
from backend.infra.observability.metrics import VoiceMetric, voice_metrics

logger = logging.getLogger("mindpal.voice")

VOICE_SESSION_COLLECTION = "voice_sessions"
VOICE_USAGE_COLLECTION = "voice_minute_reservations"
VOICE_ACTIVE_COLLECTION = "voice_active_sessions"
VOICE_EVENT_IDEMPOTENCY_COLLECTION = "voice_event_idempotency"
# 30-minute reserved call. Daily cap is also 30 minutes (one full call, or leftover
# minutes on a later call). Token TTL matches this so one Live socket can last the
# whole reservation. Do not proactive-rotate at 14 minutes — the old product held
# a 30-minute call on one socket. A measured provider limit can set
# MINDPAL_VOICE_PROVIDER_ROTATE_S (>= 60) to opt into a restart.
_VOICE_RUNTIME = voice_runtime_settings()
# Public session limits (from configs/json/voice_runtime.json).
RESERVE_SECONDS = _VOICE_RUNTIME.session.reserve_seconds
DAILY_CAP_SECONDS = _VOICE_RUNTIME.session.daily_cap_seconds
MIN_SESSION_SECONDS = _VOICE_RUNTIME.session.min_session_seconds
PROVIDER_ROTATE_S = _VOICE_RUNTIME.session.provider_rotate_seconds
HOLD_MS = _VOICE_RUNTIME.session.hold_ms
LEDGER_CHARS = _VOICE_RUNTIME.session.ledger_chars

FLOOR_STATES = frozenset(
    {"idle", "listening", "speaking", "overlapping", "holding", "yielding", "crisis_freeze"}
)

# The browser talks to Gemini Live directly, so this service can never close the
# provider socket. It instructs; the client enforces.
#
# Classification runs over the *cumulative* transcript, because a disclosure
# arrives split across ASR deltas ("i want" / " to die") and per-delta matching
# misses it.
#
# distress_support stays in the live call (stay_support). imminent_escalate is the
# only classifier path that pauses, and it speaks first: the server returns
# escalate_pause with speak_first so the client keeps the Live socket, injects a
# situation note, and only then mutes. Classifier errors are unverified: keep the
# call up and retry. The client must not pause on an unverified clock. Swearing,
# jokes, roasting, and asking for 911/988 are not a pause. MindPal mentioning
# help numbers is not user intent. No keyword list is the stay/pause authority.
# A client that stops reporting transcripts is unverified, not safe. The client
# heartbeats well inside this window even during silence. Heartbeats must not
# storm Gemini — they only refresh verification when the fingerprint is unchanged.
SAFETY_STALE_S = _VOICE_RUNTIME.session.safety_stale_seconds
SAFETY_HEARTBEAT_MS = _VOICE_RUNTIME.session.safety_heartbeat_ms
# Minted but never warmed (refresh/crash before setupComplete), or warmed then
# silent past the safety heartbeat window, is abandoned — not a live call.
ABANDONED_UNWARMED_S = _VOICE_RUNTIME.session.abandoned_unwarmed_seconds

TERMINAL_EVENTS = frozenset({"voice.session.teardown"})

# Teardown reasons a client may send that claim the call never really started.
# They are only honoured against server evidence — see `teardown`.
SETUP_FAILURE_REASONS = frozenset({"setup_timeout", "mint_failed", "setup_failed", "provider_error"})
# The widest plausible setup window. Past this the session was a call, whatever
# the client calls it on the way out.
SETUP_FAILURE_MAX_S = _VOICE_RUNTIME.session.setup_failure_max_seconds


def resolved_provider_rotate_s() -> int:
    raw = get_settings().voice_provider_rotate_s.strip()
    source = raw if raw else str(_VOICE_RUNTIME.session.provider_rotate_seconds)
    try:
        value = int(source)
    except ValueError:
        return 0
    return value if value >= 60 else 0


class VoiceSessionService:
    """Mint, reserve, record floor events, teardown. Does not write memory."""

    def __init__(
        self,
        *,
        token_service: VoiceTokenService | None = None,
        provider: LiveVoiceProvider | None = None,
        store: Any | None = None,
        flags: FeatureLifecycleEngine | None = None,
        crisis_classifier: VoiceCrisisClassifier | None = None,
    ) -> None:
        self.token_service = token_service or VoiceTokenService()
        self._provider = provider
        self._default_provider: tuple[Any, LiveVoiceProvider] | None = None
        self.store = store or get_store()
        self.flags = flags or FeatureLifecycleEngine()
        self.crisis_classifier = crisis_classifier or VoiceCrisisClassifier()
        self.event_idempotency = VoiceEventIdempotency(
            self.store,
            VOICE_EVENT_IDEMPOTENCY_COLLECTION,
        )
        self.telemetry = VoiceTelemetryService(store=self.store)
        self.usage_lifecycle = VoiceUsageLifecycle(
            store=self.store,
            session_collection=VOICE_SESSION_COLLECTION,
            usage_collection=VOICE_USAGE_COLLECTION,
            active_collection=VOICE_ACTIVE_COLLECTION,
            reserve_seconds=_VOICE_RUNTIME.session.reserve_seconds,
            daily_cap_seconds=_VOICE_RUNTIME.session.daily_cap_seconds,
            min_session_seconds=_VOICE_RUNTIME.session.min_session_seconds,
            abandoned_unwarmed_seconds=ABANDONED_UNWARMED_S,
            safety_verified=self._safety_verified,
            teardown=self.teardown,
        )

    @property
    def provider(self) -> LiveVoiceProvider:
        """The live provider; by default a Gemini provider over the *current* token service.

        Built lazily so replacing `token_service` (tests, key rotation) is honoured
        instead of silently bypassed by a provider captured at construction.
        """
        if self._provider is not None:
            return self._provider
        cached = self._default_provider
        if cached is None or cached[0] is not self.token_service:
            cached = (self.token_service, GeminiLiveVoiceProvider(self.token_service))
            self._default_provider = cached
        return cached[1]

    def mint(
        self,
        *,
        user_id_hash: str,
        is_authenticated: bool,
        consent_attested: bool,
        voice_id: Optional[str] = None,
        voice_language: Optional[str] = None,
        personalization: Optional[Dict[str, Any]] = None,
        guest_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        # Live voice is account-only. A guest call would have no server-side
        # crisis classification (session events require an account), would share
        # one quota bucket with every other guest, and would bill Gemini Live for
        # anyone with curl. Dictation remains available without signing in.
        if not is_authenticated or not user_id_hash:
            raise AppError(
                "unauthenticated",
                "Live voice requires a signed-in account. Composer dictation is available without signing in.",
            )
        policy = resolve_voice_policy(is_authenticated=True)
        if not consent_attested:
            raise AppError(
                "payload_invalid",
                "Live voice needs microphone consent before a session can start.",
            )
        if self._production_requires_durable_store() and not store_is_durable(self.store):
            logger.error("voice_mint_denied_non_durable_store")
            raise AppError(
                "unavailable",
                "Live voice is temporarily unavailable because shared session storage is not configured. Please use text or dictation.",
            )
        evaluation = self.flags.evaluate("voice.realtime", user_id_hash)
        if not evaluation.enabled:
            raise AppError(
                "forbidden",
                "Live voice is not enabled for this account. Composer dictation is still available.",
            )

        reservation = self._reserve_seconds(user_id_hash)
        session_id = f"vs_{uuid.uuid4().hex[:16]}"
        started = time.time()
        try:
            grant = self.provider.mint(
                ttl_s=reservation["reserved_s"],
                voice_id=voice_id,
                voice_language=voice_language,
                personalization=self._adapted_personalization(user_id_hash, personalization),
            )
        except Exception:
            voice_metrics().record(
                VoiceMetric(operation="mint", duration_ms=0, outcome="provider_failure", status_code=503)
            )
            self._refund(user_id_hash, reservation["reserved_s"], reason="mint_failed")
            raise

        record = {
            "session_id": session_id,
            "user_id_hash": user_id_hash,
            "session_mode": policy.session_mode,
            "status": "minted",
            "floor": "idle",
            "created_at": started,
            "expires_at": started + VOICE_TELEMETRY_RETENTION_S,
            "reserved_s": reservation["reserved_s"],
            "quota_remaining_s": reservation["remaining_s"],
            "setup_complete": False,
            "t_mint_ms": int((time.time() - started) * 1000),
            "input_transcript": "",
            "output_transcript": "",
            "input_ledger": "",
            "output_ledger": "",
            "last_safety_at": started,
            "last_classify_at": 0.0,
            "safety_checks": 0,
            # Verdicts the classifier actually returned as verified. The lease in
            # `_safety_verified` is only real once this is non-zero.
            "verified_classifies": 0,
            "gemini_classify_calls": 0,
            "gemini_classify_skips": 0,
            "working_memory": {},
        }
        self.store.set_document(VOICE_SESSION_COLLECTION, session_id, record)
        self.store.set_document(
            VOICE_ACTIVE_COLLECTION,
            user_id_hash,
            {"user_id_hash": user_id_hash, "session_id": session_id, "created_at": started},
        )
        logger.info(
            "voice_session_minted session_id=%s reserved_s=%s remaining_s=%s t_mint_ms=%s",
            session_id,
            reservation["reserved_s"],
            reservation["remaining_s"],
            record["t_mint_ms"],
        )
        self._record_telemetry(
            user_id_hash=user_id_hash,
            session_id=session_id,
            event_name="voice.session.mint",
            source="server",
            reason="session_created",
            outcome="ok",
            duration_ms=record["t_mint_ms"],
            metadata={
                "session_mode": policy.session_mode,
                "reserved_s": reservation["reserved_s"],
                "quota_remaining_s": reservation["remaining_s"],
                "auth": "authenticated",
            },
        )
        return self._client_grant(
            grant,
            record,
            quota_remaining_s=reservation["remaining_s"],
            extra={"status": "minted"},
        )

    def _memory_note(self, user_id_hash: str) -> str:
        """The caller's AI summary and most salient facts, as one line for the Live prompt.

        Before this, a live call started knowing nothing about the person; it
        could only look things up with the recall tools mid-call.
        """
        try:
            text = MemoryGraphService(self.store).prompt_for_user(user_id_hash).text
        except Exception as exc:
            logger.warning("voice_memory_note_skipped error=%s", type(exc).__name__)
            return ""
        lines = [line.strip("- ").strip() for line in text.splitlines()[2:] if line.strip()]
        return " ".join(lines)[:1400]

    def _adapted_personalization(self, user_id_hash: str, personalization: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        """Client settings plus what this caller's past conversations taught MindPal.

        The learned note is free text, so it is only ever set here from the
        server-side profile; a client-supplied value under that key is dropped.
        """
        merged = {key: value for key, value in (personalization or {}).items() if key not in SERVER_ONLY_KEYS}
        memory_note = self._memory_note(user_id_hash)
        if memory_note:
            merged[MEMORY_NOTE_KEY] = memory_note
        try:
            service = AdaptiveProfileService(self.store)
            if not service.enabled():
                return merged
            profile = service.load(user_id_hash)
            merged = merge_learned_personalization(merged, personalization_overrides(profile))
            note = preference_note(profile)
            if note:
                merged[LEARNED_NOTE_KEY] = note
        except Exception as exc:
            logger.warning("voice_adaptation_skipped error=%s", type(exc).__name__)
        return merged

    @staticmethod
    def _production_requires_durable_store() -> bool:
        """Return True when running on a shared serverless deployment where each
        request may land on a fresh instance with its own in-memory store."""
        settings = get_settings()
        environment = settings.environment.strip().lower()
        return (
            settings.vercel.strip() == "1"
            or environment in {"production", "prod"}
        )

    def handle_event(
        self,
        *,
        user_id_hash: str,
        payload: Dict[str, Any],
        idempotency_key: str = "",
    ) -> Dict[str, Any]:
        session_id = str(payload.get("session_id") or "").strip()
        return self.event_idempotency.run(
            user_id_hash=user_id_hash,
            session_id=session_id,
            key=idempotency_key,
            payload=payload,
            handler=lambda: self._handle_event_once(
                user_id_hash=user_id_hash,
                payload=payload,
            ),
        )

    def _handle_event_once(self, *, user_id_hash: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        session_id = str(payload.get("session_id") or "").strip()
        event = str(payload.get("event") or "").strip()
        if not event:
            raise AppError("payload_invalid", "Voice session events need an event name.")

        # Hang up the account's active call without the old session_id (refresh /
        # lost grant). Same-user mint also reclaims; this is the explicit End path.
        if event == "voice.session.teardown" and not session_id:
            return self.teardown_active(
                user_id_hash=user_id_hash,
                reason=str(payload.get("reason") or "client_hangup"),
                used_s=int(payload.get("used_s") or 0),
            )

        if not session_id:
            raise AppError("payload_invalid", "Voice session events need a session_id and event name.")

        record = self.store.get_document(VOICE_SESSION_COLLECTION, session_id)
        if not record or record.get("user_id_hash") != user_id_hash:
            raise AppError("not_found", "That live voice session is not available.")

        # An escalate-pause is terminal. Ordinary floor traffic used to overwrite
        # it one event later, which quietly un-froze the session server-side.
        # stay_support is not terminal: the call keeps going.
        # Any event at all proves the call was still alive at this moment. A call
        # that only ever sent floor transitions has no `last_safety_at` to settle
        # against, and would otherwise look abandoned from the instant it began.
        record["last_event_at"] = time.time()

        if self._is_frozen(record) and event not in TERMINAL_EVENTS:
            logger.info("voice_frozen_event_refused session_id=%s event=%s", session_id, event[:40])
            return self._escalate_instruction(record)

        if event == "voice.session.warm":
            record["status"] = "warm"
            record["setup_complete"] = True
            record["t_setup_ms"] = int(payload.get("t_setup_ms") or 0)
            self.store.set_document(VOICE_SESSION_COLLECTION, session_id, record)
            self._record_telemetry(
                user_id_hash=user_id_hash,
                session_id=session_id,
                event_name="voice.session.warm",
                source="client",
                reason="startup_complete",
                outcome="ok",
                duration_ms=int(payload.get("t_setup_ms") or 0),
                metadata={"t_setup_ms": int(payload.get("t_setup_ms") or 0)},
            )
            logger.info(
                "voice_session_warm session_id=%s t_setup_ms=%s",
                session_id,
                record["t_setup_ms"],
            )
            return self._ok(record)

        if event == "voice.session.renew":
            if record.get("status") in {"torn_down", "crisis_freeze"}:
                raise AppError("not_found", "That live voice session is not available.")
            evaluation = self.flags.evaluate("voice.realtime", user_id_hash)
            if not evaluation.enabled:
                raise AppError(
                    "forbidden",
                    "Live voice is not enabled for this account. Composer dictation is still available.",
                )
            reserved = int(record.get("reserved_s") or _VOICE_RUNTIME.session.reserve_seconds)
            elapsed = self._elapsed_s(record)
            if elapsed >= reserved:
                raise AppError(
                    "quota_exceeded",
                    "This live call has reached its reserved time. You can start another call or use text.",
                )
            # Fail closed: a client that has stopped reporting transcripts does not
            # get a fresh credential to keep talking with.
            if not self._safety_verified(record):
                logger.warning("voice_renew_refused_unverified session_id=%s", session_id)
                raise AppError(
                    "unavailable",
                    "Live voice stopped because the safety check could not be confirmed. You can start another call or use text.",
                )
            remaining_s = max(_VOICE_RUNTIME.session.min_session_seconds, reserved - elapsed)
            handle = str(payload.get("resumption_handle") or "").strip() or None
            try:
                grant = self.provider.mint(
                    ttl_s=min(TOKEN_TTL_SECONDS, remaining_s),
                    resumption_handle=handle,
                )
            except Exception:
                raise
            record["renewed_at"] = time.time()
            self.store.set_document(VOICE_SESSION_COLLECTION, session_id, record)
            self._record_telemetry(
                user_id_hash=user_id_hash,
                session_id=session_id,
                event_name="voice.session.renew",
                source="server",
                reason="token_renewal",
                outcome="ok",
                duration_ms=max(0, int((time.time() - float(record.get("created_at") or time.time())) * 1000)),
                metadata={"remaining_s": remaining_s, "elapsed_s": elapsed, "reserved_s": reserved},
            )
            logger.info("voice_session_renewed session_id=%s", session_id)
            return self._client_grant(
                grant,
                record,
                quota_remaining_s=int(record.get("quota_remaining_s") or 0),
                extra={
                    "ok": True,
                    "action": "continue",
                    "floor": record.get("floor"),
                    "safety_verified": True,
                    "working_memory": record.get("working_memory") or {},
                    "call_elapsed_s": elapsed,
                },
            )

        if event == "voice.floor.transition":
            dest = str(payload.get("to") or "").strip()
            if dest not in FLOOR_STATES:
                raise AppError("payload_invalid", "Unknown floor state.")
            previous = record.get("floor")
            record["floor"] = dest
            record["floor_reason"] = str(payload.get("reason") or "")[:80]
            played_ms = payload.get("played_ms")
            if isinstance(played_ms, int) and played_ms >= 0:
                record["played_ms"] = played_ms
            if dest == "crisis_freeze":
                # The client already paused (imminent, asked to leave, or audio died).
                self._record_telemetry(
                    user_id_hash=user_id_hash,
                    session_id=session_id,
                    event_name="voice.floor.transition",
                    source="client",
                    reason=record["floor_reason"] or "client_local_evidence",
                    outcome="ok",
                    metadata={"from": previous, "to": dest},
                )
                return self._escalate(
                    session_id,
                    record,
                    reason=record["floor_reason"] or "client_local_evidence",
                    source="client",
                )
            self.store.set_document(VOICE_SESSION_COLLECTION, session_id, record)
            self._record_telemetry(
                user_id_hash=user_id_hash,
                session_id=session_id,
                event_name="voice.floor.transition",
                source="client",
                reason=record["floor_reason"] or "state_change",
                outcome="ok",
                metadata={"from": previous, "to": dest},
            )
            logger.info(
                "voice_floor_transition session_id=%s from=%s to=%s reason=%s",
                session_id,
                previous,
                dest,
                record["floor_reason"],
            )
            return self._ok(record)

        if event == "voice.safety.risk_rating":
            # In-band rating from the Live model. The client has already acted on
            # it; this is a record, and it must never be able to veto or delay a
            # safety decision by being slow or unavailable.
            try:
                risk = float(payload.get("risk") or 0)
            except (TypeError, ValueError):
                risk = 0.0
            record["last_risk"] = max(0.0, min(10.0, risk))
            record["last_risk_band"] = str(payload.get("band") or "")[:16]
            record["last_risk_kind"] = str(payload.get("danger_kind") or "")[:16]
            record["risk_reports"] = int(record.get("risk_reports") or 0) + 1
            if record["last_risk_band"] in {"support", "imminent"}:
                record["risk_elevated_reports"] = int(record.get("risk_elevated_reports") or 0) + 1
            self.store.set_document(VOICE_SESSION_COLLECTION, session_id, record)
            logger.info(
                "voice_risk_rating session_id=%s risk=%.1f band=%s kind=%s confirmations=%s",
                session_id,
                record["last_risk"],
                record["last_risk_band"],
                record["last_risk_kind"],
                payload.get("confirmations"),
            )
            return self._ok(record)

        if event == "voice.safety.crisis":
            return self._escalate(
                session_id,
                record,
                reason=str(payload.get("reason") or "client_local_evidence")[:80],
                source=str(payload.get("source") or "client")[:32],
            )

        # Delta events append server-side. The current client sends cumulative
        # syncs instead, but a cached older bundle still posts deltas, and either
        # way the classifier sees the whole utterance rather than one fragment.
        if event == "voice.transcript.in_delta":
            record["input_transcript"] = _append(record.get("input_transcript"), payload.get("text"))
            record["input_ledger"] = _append(record.get("input_ledger"), payload.get("text"), _VOICE_RUNTIME.session.ledger_chars)
            return self._classify(session_id, record, is_final=bool(payload.get("is_final")))

        if event == "voice.transcript.out_delta":
            record["output_transcript"] = _append(record.get("output_transcript"), payload.get("text"))
            record["output_ledger"] = _append(record.get("output_ledger"), payload.get("text"), _VOICE_RUNTIME.session.ledger_chars)
            # Model-only deltas never call Gemini; keep the buffer for context.
            return self._classify(session_id, record, is_final=False, allow_model_only=False)

        if event == "voice.transcript.sync":
            # The client sends its own cumulative buffers. Replacing rather than
            # appending keeps the two sides from drifting on retries.
            record["input_transcript"] = _window(payload.get("input_text"))
            record["output_transcript"] = _window(payload.get("output_text"))
            inbound_ledger = _window(payload.get("input_ledger"), _VOICE_RUNTIME.session.ledger_chars)
            outbound_ledger = _window(payload.get("output_ledger"), _VOICE_RUNTIME.session.ledger_chars)
            if inbound_ledger:
                record["input_ledger"] = inbound_ledger
            elif len(record["input_transcript"]) > len(str(record.get("input_ledger") or "")):
                record["input_ledger"] = record["input_transcript"]
            if outbound_ledger:
                record["output_ledger"] = outbound_ledger
            elif len(record["output_transcript"]) > len(str(record.get("output_ledger") or "")):
                record["output_ledger"] = record["output_transcript"]
            memory = payload.get("working_memory")
            if isinstance(memory, dict):
                record["working_memory"] = _compact_working_memory(memory)
            return self._classify(
                session_id,
                record,
                is_final=bool(payload.get("is_final")),
                force=bool(payload.get("force_classify")),
            )

        if event == "voice.session.teardown":
            return self.teardown(
                user_id_hash=user_id_hash,
                session_id=session_id,
                reason=str(payload.get("reason") or "client_hangup"),
                used_s=int(payload.get("used_s") or 0),
            )

        raise AppError("payload_invalid", "Unknown voice session event.")

    def teardown(
        self,
        *,
        user_id_hash: str,
        session_id: str,
        reason: str,
        used_s: int = 0,
    ) -> Dict[str, Any]:
        record = self.store.get_document(VOICE_SESSION_COLLECTION, session_id)
        if not record or record.get("user_id_hash") != user_id_hash:
            raise AppError("not_found", "That live voice session is not available.")
        if record.get("status") == "torn_down":
            return {
                "ok": True,
                "action": "torn_down",
                "refund_s": 0,
                "already_settled": True,
            }

        reserved = int(record.get("reserved_s") or 0)
        elapsed = self._elapsed_s(record)
        # A reclaim has no caller telling us when the call ended, so wall clock
        # is the wrong meter: a tab that crashed two minutes in would be billed
        # for the whole reservation. Bill to the last moment the server saw the
        # call alive instead.
        billable = self._observed_elapsed_s(record) if reason in self.RECLAIM_REASONS else elapsed
        # Client used_s is telemetry, not settlement. Server clock from mint.
        hint = max(0, int(used_s or 0))

        # A full refund is settled from the server's own record of the session,
        # never from the word the client puts in `reason`. Sending
        # reason="setup_timeout" at the end of a real 29-minute call used to
        # hand back the entire day's voice allowance — an unlimited-minutes
        # bypass available to anyone who could edit one request body.
        setup_failed = self._is_genuine_setup_failure(record, reason, observed_s=self._observed_elapsed_s(record))
        if reason in SETUP_FAILURE_REASONS and not setup_failed:
            logger.warning(
                "voice_teardown_reason_disputed session_id=%s claimed=%s warmed=%s observed_s=%s",
                session_id,
                reason[:40],
                bool(record.get("setup_complete")),
                self._observed_elapsed_s(record),
            )
            record["disputed_teardown_reason"] = reason[:80]
            reason = "client_hangup"

        used = 0 if setup_failed else min(billable, reserved)
        refund_s = reserved if setup_failed else max(0, reserved - used)
        if refund_s:
            self._refund(user_id_hash, refund_s, reason=reason)

        record["status"] = "torn_down"
        record["teardown_reason"] = reason[:80]
        record["used_s"] = 0 if setup_failed else used
        record["client_used_s"] = hint
        record["ended_at"] = time.time()
        self.store.set_document(VOICE_SESSION_COLLECTION, session_id, record)
        self._record_telemetry(
            user_id_hash=user_id_hash,
            session_id=session_id,
            event_name="voice.session.teardown",
            source="server",
            reason=reason,
            outcome="ok",
            duration_ms=int(max(0, elapsed) * 1000),
            metadata={
                "reason": reason,
                "refund_s": refund_s,
                "used_s": record["used_s"],
                "client_used_s": hint,
                "setup_failed": setup_failed,
            },
        )
        self._clear_active(user_id_hash, session_id)
        logger.info(
            "voice_session_teardown session_id=%s reason=%s refund_s=%s used_s=%s elapsed_s=%s client_used_s=%s",
            session_id,
            reason[:80],
            refund_s,
            record["used_s"],
            elapsed,
            hint,
        )
        return {"ok": True, "action": "torn_down", "refund_s": refund_s, "used_s": record["used_s"]}

    @staticmethod
    def _is_genuine_setup_failure(record: Dict[str, Any], reason: str, *, observed_s: int) -> bool:
        """Did this session really fail before it became a call?

        Three server-side facts have to agree: the client claimed a setup
        failure, the session never reported `voice.session.warm`, and the last
        moment the server saw it alive was inside the setup window. Any one of
        them missing means a call happened and its minutes are spent.
        """
        if reason not in SETUP_FAILURE_REASONS:
            return False
        if record.get("setup_complete"):
            return False
        return observed_s <= SETUP_FAILURE_MAX_S

    def teardown_active(
        self,
        *,
        user_id_hash: str,
        reason: str = "client_hangup",
        used_s: int = 0,
    ) -> Dict[str, Any]:
        """Tear down the account's active live session without a known session_id."""
        active = self.store.get_document(VOICE_ACTIVE_COLLECTION, user_id_hash)
        session_id = str((active or {}).get("session_id") or "")
        if not session_id:
            return {
                "ok": True,
                "action": "torn_down",
                "refund_s": 0,
                "already_settled": True,
                "no_active": True,
            }
        existing = self.store.get_document(VOICE_SESSION_COLLECTION, session_id)
        if not existing or existing.get("user_id_hash") != user_id_hash:
            self.store.delete_document(VOICE_ACTIVE_COLLECTION, user_id_hash)
            return {
                "ok": True,
                "action": "torn_down",
                "refund_s": 0,
                "already_settled": True,
                "no_active": True,
            }
        result = self.teardown(
            user_id_hash=user_id_hash,
            session_id=session_id,
            reason=reason,
            used_s=used_s,
        )
        return {**result, "session_id": session_id}

    # --- safety ---------------------------------------------------------------

    def _classify(
        self,
        session_id: str,
        record: Dict[str, Any],
        *,
        is_final: bool = False,
        force: bool = False,
        allow_model_only: bool = True,
    ) -> Dict[str, Any]:
        """Classify cumulative transcripts with the Gemini JSON classifier.

        Debounced: unchanged fingerprints refresh verification without a Gemini
        call; model-only updates never classify; partials respect a hard min
        interval. User finals may classify sooner. Classifier errors keep the
        call up (`continue`, safety_verified=false) so the client retries.
        """
        inbound = record.get("input_transcript") or ""
        outbound = record.get("output_transcript") or ""
        fingerprint = f"{inbound}\n{outbound}"
        prior_input = str(record.get("classified_input") or "")
        prior_fp = str(record.get("safety_fingerprint") or "")

        if fingerprint == prior_fp and self._safety_verified(record):
            return self._refresh_verified(session_id, record, reason="unchanged_fingerprint")

        if fingerprint == prior_fp and (self._ever_verified(record) or not self._has_user_speech(record)):
            # Stale lease, identical speech that was already classified: extend
            # without another Gemini call. Speech that has never been classified
            # falls through to the gate below instead — re-stamping it here was
            # how an unclassified call stayed "verified" indefinitely.
            return self._refresh_verified(session_id, record, reason="fingerprint_reverify")

        gate = should_run_classify(
            # In verify mode the Live model's own rating decides whether this
            # independent check is worth a call.
            risk_elevated=str(record.get("last_risk_band") or "") in {"support", "imminent"},
            input_text=inbound,
            output_text=outbound,
            prior_input=prior_input,
            prior_fingerprint=prior_fp,
            last_classify_at=record.get("last_classify_at"),
            is_final=is_final,
            force=force,
        )
        if not gate.run:
            record["gemini_classify_skips"] = int(record.get("gemini_classify_skips") or 0) + 1
            record["last_classify_skip_reason"] = gate.reason
            # Persist buffers / memory even when Gemini is skipped.
            if gate.reason in {"model_only", "no_user_speech"} and not allow_model_only:
                record["safety_fingerprint"] = fingerprint
            self.store.set_document(VOICE_SESSION_COLLECTION, session_id, record)
            logger.info(
                "voice_classify_skipped session_id=%s reason=%s skips=%s calls=%s",
                session_id,
                gate.reason,
                record["gemini_classify_skips"],
                int(record.get("gemini_classify_calls") or 0),
            )
            if self._is_frozen(record):
                return self._escalate_instruction(record)
            if record.get("speak_then_pause"):
                return self._speak_first_instruction(record)
            if record.get("stay_support"):
                return self._stay_instruction(record)
            # Keep the call verified when we intentionally coalesced; the speech
            # was already classified recently. Unverified only when we never had
            # a successful classify yet and are waiting on interval/backoff.
            if self._safety_verified(record) or gate.reason in {
                "unchanged_fingerprint",
                "model_only",
                "no_user_speech",
                "partial_too_small",
                "min_interval",
                "coalesced",
            }:
                if gate.reason in {
                    "min_interval",
                    "partial_too_small",
                    "coalesced",
                    "model_only",
                    "no_user_speech",
                } and (self._ever_verified(record) or not self._has_user_speech(record)):
                    record["last_safety_at"] = time.time()
                    self.store.set_document(VOICE_SESSION_COLLECTION, session_id, record)
                if not self._safety_verified(record):
                    return {
                        "ok": True,
                        "action": "continue",
                        "floor": record.get("floor"),
                        "safety_verified": False,
                    }
                return self._ok(record)
            return {
                "ok": True,
                "action": "continue",
                "floor": record.get("floor"),
                "safety_verified": False,
            }

        already = bool(record.get("stay_support"))
        classify_in, classify_out = inbound, outbound
        if already:
            classify_in = _speech_delta(record.get("stay_support_input"), inbound)
            classify_out = _speech_delta(record.get("stay_support_output"), outbound)
            if not classify_in and not classify_out:
                # No new speech since the stay-support verdict: that verdict is
                # still the verified answer for everything said so far.
                record["last_safety_at"] = time.time()
                record["safety_fingerprint"] = fingerprint
                record["classified_input"] = inbound
                record["safety_checks"] = int(record.get("safety_checks") or 0) + 1
                self.store.set_document(VOICE_SESSION_COLLECTION, session_id, record)
                if record.get("speak_then_pause") and not self._is_frozen(record):
                    return self._speak_first_instruction(record)
                return self._stay_instruction(record)

        verdict = self.crisis_classifier.classify(classify_in, classify_out)
        record["safety_checks"] = int(record.get("safety_checks") or 0) + 1
        record["gemini_classify_calls"] = int(record.get("gemini_classify_calls") or 0) + 1
        record["last_classify_at"] = time.time()
        record["last_classify_reason"] = gate.reason
        budget = get_gemini_call_budget().snapshot()
        logger.info(
            "voice_classify_ran session_id=%s reason=%s calls=%s skips=%s gemini_60s=%s verified=%s",
            session_id,
            gate.reason,
            record["gemini_classify_calls"],
            int(record.get("gemini_classify_skips") or 0),
            budget.get("calls_last_60s"),
            verdict.verified,
        )
        if not verdict.verified:
            voice_metrics().record(
                VoiceMetric(
                    operation="safety_classifier",
                    duration_ms=0,
                    outcome="safety_classifier_failure",
                    status_code=503,
                )
            )
            self.store.set_document(VOICE_SESSION_COLLECTION, session_id, record)
            return {
                "ok": True,
                "action": "continue",
                "floor": record.get("floor"),
                "safety_verified": False,
            }

        record["last_safety_at"] = time.time()
        record["safety_fingerprint"] = fingerprint
        record["classified_input"] = inbound
        record["verified_classifies"] = int(record.get("verified_classifies") or 0) + 1

        user_speech = bool(str(classify_in or "").strip())
        if verdict.is_imminent and user_speech:
            # No crisis pause: the call is never frozen or ended on the caller.
            # An imminent verdict keeps them on the line in support mode, and the
            # flag tells the client to have MindPal name immediate help out loud.
            record["imminent"] = True
            record["danger_kind"] = verdict.danger_kind or record.get("danger_kind")
            return self._stay(
                session_id,
                record,
                fingerprint=fingerprint,
                reason=verdict.trigger_reason or "ai_classifier",
            )
        if verdict.is_distress_support and user_speech:
            return self._stay(
                session_id,
                record,
                fingerprint=fingerprint,
                reason=verdict.trigger_reason or "ai_classifier",
            )

        if already:
            record["stay_support_input"] = inbound
            record["stay_support_output"] = outbound
        self.store.set_document(VOICE_SESSION_COLLECTION, session_id, record)
        return self._ok(record)

    def _refresh_verified(self, session_id: str, record: Dict[str, Any], *, reason: str) -> Dict[str, Any]:
        record["last_safety_at"] = time.time()
        record["gemini_classify_skips"] = int(record.get("gemini_classify_skips") or 0) + 1
        record["last_classify_skip_reason"] = reason
        self.store.set_document(VOICE_SESSION_COLLECTION, session_id, record)
        if self._is_frozen(record):
            return self._escalate_instruction(record)
        if record.get("speak_then_pause"):
            return self._speak_first_instruction(record)
        if record.get("stay_support"):
            return self._stay_instruction(record)
        return self._ok(record)

    def _stay(
        self,
        session_id: str,
        record: Dict[str, Any],
        *,
        fingerprint: str,
        reason: str,
    ) -> Dict[str, Any]:
        record["stay_support"] = True
        record["stay_support_at"] = record.get("stay_support_at") or time.time()
        record["stay_support_fingerprint"] = fingerprint
        record["stay_support_input"] = record.get("input_transcript") or ""
        record["stay_support_output"] = record.get("output_transcript") or ""
        record["stay_support_reason"] = (reason or "")[:80]
        record["inhibit_memory"] = True
        if record.get("status") not in {"torn_down", "crisis_freeze"}:
            record["status"] = "stay_support"
        record["last_safety_at"] = time.time()
        self.store.set_document(VOICE_SESSION_COLLECTION, session_id, record)
        logger.info(
            "voice_safety_stay_support session_id=%s trigger_present=%s",
            session_id,
            bool(reason),
        )
        return self._stay_instruction(record)

    def _stay_instruction(self, record: Dict[str, Any]) -> Dict[str, Any]:
        instruction: Dict[str, Any] = {
            "ok": True,
            "action": "stay_support",
            "floor": record.get("floor"),
            "terminal": False,
            "label": DISTRESS_SUPPORT,
            "session_note": STAY_SUPPORT_NOTE,
            "safety_verified": True,
        }
        if record.get("imminent"):
            instruction["imminent"] = True
            instruction["danger_kind"] = record.get("danger_kind")
        return instruction

    def _begin_speak_then_pause(
        self,
        session_id: str,
        record: Dict[str, Any],
        *,
        reason: str,
        source: str,
        crisis_response: str | None = None,
        danger_kind: str | None = None,
    ) -> Dict[str, Any]:
        inbound = str(record.get("input_transcript") or "")
        kind = danger_kind or DANGER_UNSPECIFIED
        record["speak_then_pause"] = True
        record["speak_then_pause_at"] = record.get("speak_then_pause_at") or time.time()
        record["inhibit_memory"] = True
        record["crisis_source"] = source
        record["crisis_trigger"] = (reason or "")[:80]
        record["crisis_response"] = crisis_response or record.get("crisis_response") or CRISIS_RESPONSE
        record["danger_kind"] = kind
        record["pause_body"] = pause_body(kind)
        record["session_note"] = speak_then_pause_note(inbound, kind)
        record["situation_nudge"] = situation_nudge(inbound)
        if record.get("status") not in {"torn_down", "crisis_freeze"}:
            record["status"] = "speak_then_pause"
        record["last_safety_at"] = time.time()
        self.store.set_document(VOICE_SESSION_COLLECTION, session_id, record)
        logger.info(
            "voice_safety_speak_then_pause session_id=%s source=%s danger_kind=%s",
            session_id,
            source,
            kind,
        )
        return self._speak_first_instruction(record)

    def _speak_first_instruction(self, record: Dict[str, Any]) -> Dict[str, Any]:
        inbound = str(record.get("input_transcript") or "")
        kind = str(record.get("danger_kind") or DANGER_UNSPECIFIED)
        return {
            "ok": True,
            "action": "escalate_pause",
            "speak_first": True,
            "terminal": False,
            "floor": record.get("floor"),
            "label": IMMINENT_ESCALATE,
            "session_note": record.get("session_note") or speak_then_pause_note(inbound, kind),
            "situation_nudge": record.get("situation_nudge") or situation_nudge(inbound),
            "pause_body": record.get("pause_body") or pause_body(kind),
            "danger_kind": kind,
            "crisis_response": record.get("crisis_response") or CRISIS_RESPONSE,
            "safety_verified": True,
        }

    def _escalate(
        self,
        session_id: str,
        record: Dict[str, Any],
        *,
        reason: str,
        source: str,
        crisis_response: str | None = None,
    ) -> Dict[str, Any]:
        record["floor"] = "crisis_freeze"
        record["status"] = "crisis_freeze"
        record["inhibit_memory"] = True
        record["crisis_source"] = source
        record["crisis_trigger"] = (reason or "")[:80]
        record["crisis_at"] = time.time()
        record["last_safety_at"] = time.time()
        record["crisis_response"] = crisis_response or record.get("crisis_response") or CRISIS_RESPONSE
        self.store.set_document(VOICE_SESSION_COLLECTION, session_id, record)
        logger.info(
            "voice_safety_escalate_pause session_id=%s source=%s trigger_present=%s",
            session_id,
            source,
            bool(record["crisis_trigger"]),
        )
        return self._escalate_instruction(record)

    def _escalate_instruction(self, record: Dict[str, Any]) -> Dict[str, Any]:
        kind = str(record.get("danger_kind") or DANGER_UNSPECIFIED)
        return {
            "ok": True,
            "action": "escalate_pause",
            "speak_first": False,
            "floor": "crisis_freeze",
            "terminal": True,
            "label": IMMINENT_ESCALATE,
            "crisis_response": record.get("crisis_response") or CRISIS_RESPONSE,
            "pause_body": record.get("pause_body") or pause_body(kind),
            "danger_kind": kind,
            "safety_verified": True,
        }

    def _ok(self, record: Dict[str, Any]) -> Dict[str, Any]:
        body: Dict[str, Any] = {
            "ok": True,
            "action": "continue",
            "floor": record.get("floor"),
            "safety_verified": self._safety_verified(record),
        }
        memory = record.get("working_memory")
        if isinstance(memory, dict) and memory:
            body["working_memory"] = memory
        calls = int(record.get("gemini_classify_calls") or 0)
        skips = int(record.get("gemini_classify_skips") or 0)
        if calls or skips:
            body["gemini_classify_calls"] = calls
            body["gemini_classify_skips"] = skips
        return body

    def _record_telemetry(
        self,
        *,
        user_id_hash: str,
        session_id: str,
        event_name: str,
        source: str = "server",
        reason: str | None = None,
        outcome: str = "ok",
        duration_ms: int | None = None,
        metadata: Dict[str, Any] | None = None,
    ) -> None:
        self.telemetry.record_event(
            user_id_hash=user_id_hash,
            session_id=session_id,
            event_name=event_name,
            source=source,
            reason=reason or "",
            outcome=outcome,
            duration_ms=duration_ms,
            metadata=metadata or {},
        )
        metric_operation = "teardown" if event_name == "voice.session.teardown" else (
            "reconnect" if event_name == "voice.session.renew" else "session"
        )
        metric_outcome = outcome
        if event_name.startswith("voice.safety") and outcome != "ok":
            metric_outcome = "safety_classifier_failure"
        if reason in {"provider_error", "mint_failed"}:
            metric_outcome = "provider_failure"
        voice_metrics().record(
            VoiceMetric(
                operation=metric_operation,
                duration_ms=int(duration_ms or 0),
                outcome=f"{metric_outcome}:{reason[:24]}" if event_name == "voice.session.teardown" else metric_outcome,
                status_code=200,
            )
        )

    def _client_grant(
        self,
        grant: Dict[str, Any],
        record: Dict[str, Any],
        *,
        quota_remaining_s: int,
        extra: Dict[str, Any] | None = None,
    ) -> Dict[str, Any]:
        body = {
            **grant,
            "session_id": record["session_id"],
            "quota_remaining_s": quota_remaining_s,
            "hold_ms": _VOICE_RUNTIME.session.hold_ms,
            "session_limit_s": int(record.get("reserved_s") or _VOICE_RUNTIME.session.reserve_seconds),
            "safety_heartbeat_ms": SAFETY_HEARTBEAT_MS,
            **(extra or {}),
        }
        rotate = resolved_provider_rotate_s()
        if rotate:
            body["provider_rotate_s"] = rotate
        # Which models are actually serving this call. The Live model is already
        # in `grant`, but the classifier and chat models are resolved from server
        # env the browser cannot see - and a diagnostic report that does not say
        # which classifier produced a verdict cannot be reasoned about.
        body["models"] = self.model_manifest()
        body["provider"] = {
            "name": self.provider.name,
            "health": asdict(self.provider.health()),
            "capabilities": asdict(self.provider.capabilities()),
        }
        return body

    @staticmethod
    def model_manifest() -> Dict[str, Any]:
        """Non-secret record of which provider and model serves each path."""
        from backend.domain.voice.providers.gemini.budget import classifier_mode
        from backend.infra.llm.gateway import (
            chat_provider,
            default_chat_model,
            json_model,
            structured_provider,
        )
        from backend.infra.llm.openrouter import default_chat_model_for, default_json_model_for

        chat = chat_provider()
        structured = structured_provider()
        return {
            "live": live_model_id(),
            "live_voice": live_voice_id(),
            "chat_provider": chat,
            "chat_model": default_chat_model() if chat == "gemini" else default_chat_model_for(chat),
            "classifier_provider": structured,
            "classifier_model": json_model()
            if structured == "gemini"
            else default_json_model_for(structured),
            "classifier_mode": classifier_mode(),
        }

    @staticmethod
    def _has_user_speech(record: Dict[str, Any]) -> bool:
        """Has this caller ever said anything the server has seen?

        Read from the ledger, not the rolling window: the window slides, and a
        disclosure that scrolled out of it is still speech that was spoken.
        """
        return bool(
            str(record.get("input_ledger") or record.get("input_transcript") or "").strip()
        )

    @staticmethod
    def _ever_verified(record: Dict[str, Any]) -> bool:
        return int(record.get("verified_classifies") or 0) > 0

    def _safety_verified(self, record: Dict[str, Any]) -> bool:
        """Is this session's safety lease both fresh and actually earned?

        `last_safety_at` alone was not enough. Mint stamped it, and every
        debounce path refreshed it, so a client whose transcript syncs always
        landed on a skip (`min_interval`, `model_only`, `no_user_speech`) held a
        permanently "verified" call that no classifier had ever looked at. A
        lease now requires either a classifier verdict that came back verified,
        or a caller who has not spoken yet — for whom there is honestly nothing
        to classify.
        """
        last = record.get("last_safety_at")
        if not isinstance(last, (int, float)):
            return False
        if (time.time() - float(last)) > SAFETY_STALE_S:
            return False
        return self._ever_verified(record) or not self._has_user_speech(record)

    @staticmethod
    def _is_frozen(record: Dict[str, Any]) -> bool:
        return record.get("status") == "crisis_freeze" or record.get("floor") == "crisis_freeze"

    def usage_snapshot(self, user_id_hash: str) -> Dict[str, Any]:
        policy = resolve_voice_policy(is_authenticated=True)
        usage = self.usage_lifecycle.usage_snapshot(user_id_hash)
        minutes = max(1, policy.daily_cap_seconds // 60)
        return {
            **usage,
            "session_mode": policy.session_mode,
            "quota_label": policy.quota_label,
            "max_session_seconds": policy.max_session_seconds,
            "daily_cap_seconds": policy.daily_cap_seconds,
            "quota_message": f"Live voice is included for signed-in accounts, up to {minutes} minutes per day.",
        }

    def _unspent_hold_s(self, record: Dict[str, Any]) -> int:
        return self.usage_lifecycle.unspent_hold_s(record)

    def _reserve_seconds(self, user_id_hash: str) -> Dict[str, int]:
        return self.usage_lifecycle.reserve_seconds_for(user_id_hash)

    def _reclaim_active_for_mint(self, user_id_hash: str) -> None:
        self.usage_lifecycle.reclaim_active_for_mint(user_id_hash)

    def _reclaim_reason(self, record: Dict[str, Any]) -> str:
        return self.usage_lifecycle.reclaim_reason(record)

    def _clear_active(self, user_id_hash: str, session_id: str) -> None:
        self.usage_lifecycle.clear_active(user_id_hash, session_id)

    @staticmethod
    def _elapsed_s(record: Dict[str, Any]) -> int:
        return VoiceUsageLifecycle.elapsed_s(record)

    # Teardown reasons that mean nobody told us the call ended - it was found
    # abandoned. Billing these to wall clock charges a crashed tab for every
    # minute since, which for a 30-minute reservation is the whole day.
    RECLAIM_REASONS = RECLAIM_REASONS

    @staticmethod
    def _observed_elapsed_s(record: Dict[str, Any]) -> int:
        return VoiceUsageLifecycle.observed_elapsed_s(record)

    def _refund(self, user_id_hash: str, seconds: int, *, reason: str) -> None:
        self.usage_lifecycle.refund(user_id_hash, seconds, reason=reason)

    @staticmethod
    def _normalize_usage(usage: Any, user_id_hash: str) -> Dict[str, Any]:
        return VoiceUsageLifecycle.normalize_usage(usage, user_id_hash)

    def _usage(self, user_id_hash: str) -> Dict[str, Any]:
        return self.usage_lifecycle.usage(user_id_hash)
