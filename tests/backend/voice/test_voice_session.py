# tests/backend/voice/test_voice_session.py — reservation, teardown, safety freeze

from __future__ import annotations

import time

import pytest

from backend.core.errors import AppError
from backend.domain.flags.engine import FeatureLifecycleEngine
from backend.domain.flags.models import FeatureDefinition, FeatureStage
from backend.domain.voice.services.session import (
    DAILY_CAP_SECONDS,
    HOLD_MS,
    MIN_SESSION_SECONDS,
    PROVIDER_ROTATE_S,
    RESERVE_SECONDS,
    SAFETY_STALE_S,
    VOICE_SESSION_COLLECTION,
    VOICE_USAGE_COLLECTION,
    VoiceSessionService,
)
from backend.domain.voice.providers.gemini import budget as gemini_budget_mod
from backend.domain.voice.providers.gemini.budget import reset_gemini_call_budget, should_run_classify
from backend.domain.voice.services.token import LIVE_SILENCE_DURATION_MS, TOKEN_TTL_SECONDS
from backend.domain.safety.modes.chat.classify import CRISIS_RESPONSE
from backend.domain.safety.modes.voice.classify import (
    DISTRESS_SUPPORT,
    IMMINENT_ESCALATE,
    NOT_CRISIS,
    STAY_SUPPORT_NOTE,
    VoiceCrisisClassifier,
    VoiceSafetyVerdict,
    reset_rate_limit_state,
)
from backend.infra.store.store import InMemoryStore


@pytest.fixture(autouse=True)
def _fast_classify_intervals(monkeypatch: pytest.MonkeyPatch) -> None:
    """Existing safety tests fire many syncs in one tick; keep interval gating in dedicated tests."""
    monkeypatch.setattr(gemini_budget_mod, "CLASSIFY_MIN_INTERVAL_S", 0.0)
    monkeypatch.setattr(gemini_budget_mod, "CLASSIFY_FINAL_MIN_INTERVAL_S", 0.0)
    reset_gemini_call_budget()
    reset_rate_limit_state()


class _FakeToken:
    def mint_ephemeral_token(self, **kwargs) -> dict:
        return {
            "token": "authTokens/unit",
            "expires_at": "2026-09-15T00:05:00Z",
            "ws_url": "wss://example.invalid/BidiGenerateContentConstrained?access_token=authTokens%2Funit",
            "model": "models/gemini-2.5-flash-native-audio-preview-12-2025",
            "voice_id": "Kore",
            "setup": {"setup": {"model": "models/x"}},
            "setup_timeout_ms": 12000,
        }


def _enabled_engine() -> FeatureLifecycleEngine:
    return FeatureLifecycleEngine(
        registry=[
            FeatureDefinition(key="voice.realtime", stage=FeatureStage.CANARY, rollout_percentage=100),
        ]
    )


class _FakeCrisis:
    """Test double for the Gemini JSON classifier. Not the production keyword list."""

    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail

    def classify(self, input_text: str, output_text: str = "") -> VoiceSafetyVerdict:
        if self.fail:
            return VoiceSafetyVerdict(label=NOT_CRISIS, verified=False)
        blob = str(input_text or "").lower()
        if any(
            marker in blob
            for marker in ("laughing", "hilarious", "joke", "kidding", "wifi is dead", "roast")
        ):
            return VoiceSafetyVerdict(label=NOT_CRISIS, verified=True)
        imminent_markers = (
            "taking them now",
            "taking them right now",
            "have the pills",
            "have a gun",
            "jump right now",
            "doing it now",
            "doing it right now",
            "running from a killer",
            "from a killer",
            "being chased",
        )
        if any(marker in blob for marker in imminent_markers):
            kind = "physical" if ("killer" in blob or "chased" in blob) else "self_harm"
            return VoiceSafetyVerdict(
                label=IMMINENT_ESCALATE,
                verified=True,
                trigger_reason="ai_classifier",
                crisis_response=CRISIS_RESPONSE,
                danger_kind=kind,
            )
        markers = (
            "kill myself",
            "kill my self",
            "want to die",
            "wanna die",
            "dont want to live",
            "do not want to live",
            "اموت",
        )
        if any(marker in blob for marker in markers):
            return VoiceSafetyVerdict(
                label=DISTRESS_SUPPORT,
                verified=True,
                trigger_reason="ai_classifier",
            )
        return VoiceSafetyVerdict(label=NOT_CRISIS, verified=True)


def _service(store: InMemoryStore | None = None, crisis: object | None = None) -> VoiceSessionService:
    return VoiceSessionService(
        token_service=_FakeToken(),
        store=store or InMemoryStore(),
        flags=_enabled_engine(),
        crisis_classifier=crisis or _FakeCrisis(),
    )


def test_mint_requires_auth_and_consent() -> None:
    service = _service()
    with pytest.raises(AppError) as guest:
        service.mint(user_id_hash="usr_anon_default", is_authenticated=False, consent_attested=True)
    assert guest.value.code == "unauthenticated"

    with pytest.raises(AppError) as consent:
        service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=False)
    assert consent.value.code == "payload_invalid"


def test_mint_respects_dark_launch_flag() -> None:
    service = VoiceSessionService(
        token_service=_FakeToken(),
        store=InMemoryStore(),
        flags=FeatureLifecycleEngine(
            registry=[FeatureDefinition(key="voice.realtime", stage=FeatureStage.DARK_LAUNCH)]
        ),
    )
    with pytest.raises(AppError) as exc:
        service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    assert exc.value.code == "forbidden"


def test_mint_forbidden_when_voice_live_env_off(monkeypatch) -> None:
    monkeypatch.setenv("MINDPAL_VOICE_LIVE", "0")
    service = VoiceSessionService(
        token_service=_FakeToken(),
        store=InMemoryStore(),
        flags=FeatureLifecycleEngine(),
    )
    with pytest.raises(AppError) as exc:
        service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    assert exc.value.code == "forbidden"


def test_mint_allows_default_voice_flag() -> None:
    service = VoiceSessionService(
        token_service=_FakeToken(),
        store=InMemoryStore(),
        flags=FeatureLifecycleEngine(),
    )
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    assert grant["session_id"].startswith("vs_")


def test_mint_reserves_voice_seconds_not_chat_credits() -> None:
    store = InMemoryStore()
    grant = _service(store).mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    assert grant["session_id"].startswith("vs_")
    assert not grant["token"].startswith("vt_")
    # What is left to them, not what is left after this call's own hold.
    # RESERVE_SECONDS == DAILY_CAP_SECONDS, so the post-deduction figure is
    # always zero and told a caller starting a full-length call that today's
    # minutes were used up.
    assert grant["quota_remaining_s"] == DAILY_CAP_SECONDS
    record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
    assert record["reserved_s"] == RESERVE_SECONDS
    assert record["status"] == "minted"
    assert grant["hold_ms"] == HOLD_MS
    assert grant["session_limit_s"] == RESERVE_SECONDS
    assert grant.get("provider_rotate_s") in (None, 0)
    assert RESERVE_SECONDS == 1800
    assert DAILY_CAP_SECONDS == 1800
    assert TOKEN_TTL_SECONDS == 1800
    assert RESERVE_SECONDS == TOKEN_TTL_SECONDS
    assert PROVIDER_ROTATE_S == 0
    assert HOLD_MS != LIVE_SILENCE_DURATION_MS
    # Relaxed from 700ms: with END_SENSITIVITY_HIGH that ended a turn on any
    # breath or thinking pause, which cut callers off mid-story. Barge-in is
    # start-of-speech plus the provider's `interrupted`, so it is unaffected.
    assert 1200 <= LIVE_SILENCE_DURATION_MS <= 2000


def test_setup_timeout_refunds_reservation() -> None:
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    result = service.teardown(
        user_id_hash="usr_signed",
        session_id=grant["session_id"],
        reason="setup_timeout",
        used_s=12,
    )
    assert result["refund_s"] == RESERVE_SECONDS
    record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
    assert record["status"] == "torn_down"
    assert record["used_s"] == 0


def test_partial_transcript_distress_stays_in_voice() -> None:
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    result = service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.in_delta",
            "text": "I want to kill myself",
            "is_final": False,
        },
    )
    assert result["action"] == "stay_support"
    assert result["terminal"] is False
    assert result["floor"] != "crisis_freeze"
    assert STAY_SUPPORT_NOTE in (result.get("session_note") or "")
    record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
    assert record["inhibit_memory"] is True
    assert record["status"] == "stay_support"
    assert record["floor"] != "crisis_freeze"


def test_imminent_plan_stays_on_the_call_and_never_freezes() -> None:
    """There is no crisis pause.

    An imminent verdict used to start "speak, then pause" and end in a frozen
    call. It now keeps the caller on the line in support mode, flagged
    imminent, so the client has MindPal name immediate help out loud.
    """
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    result = service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.sync",
            "input_text": "I have the pills and I am taking them now",
            "output_text": "",
        },
    )
    assert result["action"] == "stay_support"
    assert result["imminent"] is True
    assert result["terminal"] is False
    assert result.get("floor") != "crisis_freeze"
    assert "988" in (result.get("session_note") or "")
    record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
    assert record["status"] == "stay_support"
    assert record["floor"] != "crisis_freeze"
    assert record["inhibit_memory"] is True


def test_floor_transition_stores_optional_played_ms() -> None:
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    result = service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.floor.transition",
            "to": "overlapping",
            "reason": "provider_interrupted",
            "played_ms": 1240,
        },
    )
    assert result["ok"] is True
    record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
    assert record["floor"] == "overlapping"
    assert record["played_ms"] == 1240


def test_daily_cap_fail_closed() -> None:
    store = InMemoryStore()
    service = _service(store)
    for _ in range(DAILY_CAP_SECONDS // RESERVE_SECONDS):
        grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
        record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
        record["created_at"] = time.time() - RESERVE_SECONDS
        store.set_document(VOICE_SESSION_COLLECTION, grant["session_id"], record)
        service.teardown(
            user_id_hash="usr_signed",
            session_id=grant["session_id"],
            reason="client_hangup",
            used_s=RESERVE_SECONDS,
        )
    with pytest.raises(AppError) as exc:
        service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    assert exc.value.code == "quota_exceeded"
    assert "chat credits" in exc.value.message.lower()


def test_cumulative_transcript_catches_a_phrase_split_across_deltas() -> None:
    """No single ASR delta is a disclosure; the accumulated utterance is."""
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    results = [
        service.handle_event(
            user_id_hash="usr_signed",
            payload={
                "session_id": grant["session_id"],
                "event": "voice.transcript.in_delta",
                "text": delta,
            },
        )
        for delta in ("i", " want", " to", " die")
    ]
    assert [row["action"] for row in results[:-1]] == ["continue", "continue", "continue"]
    assert results[-1]["action"] == "stay_support"
    assert results[-1]["terminal"] is False
    record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
    assert record["stay_support"] is True
    assert record["inhibit_memory"] is True
    assert record["status"] == "stay_support"


def test_sync_event_classifies_client_cumulative_buffers() -> None:
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    calm = service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.sync",
            "input_text": "work has been really heavy lately",
            "output_text": "that sounds like a lot to carry",
        },
    )
    assert calm["action"] == "continue"
    assert calm["safety_verified"] is True

    stayed = service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.sync",
            "input_text": "honestly i dont want to live any more",
            "output_text": "",
        },
    )
    assert stayed["action"] == "stay_support"
    assert stayed["terminal"] is False
    assert STAY_SUPPORT_NOTE in (stayed.get("session_note") or "")


def test_model_output_alone_is_not_a_user_intent_freeze() -> None:
    """The classifier sees model speech as context, not as the user's disclosure."""
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    result = service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.out_delta",
            "text": "it sounds like you are thinking about suicide",
        },
    )
    assert result["action"] == "continue"
    assert result["safety_verified"] is True


def test_an_imminent_call_keeps_working_for_every_event() -> None:
    """With no pause, nothing after an imminent verdict is refused.

    The old behaviour froze the session and answered every later event with
    escalate_pause. The call now carries on normally in support mode.
    """
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    first = service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.sync",
            "input_text": "I have the pills and I am taking them now",
        },
    )
    assert first["action"] == "stay_support"
    assert first["imminent"] is True

    for payload in (
        {"event": "voice.floor.transition", "to": "speaking", "reason": "model_audio"},
        {"event": "voice.floor.transition", "to": "listening", "reason": "playback_idle"},
        {"event": "voice.transcript.sync", "input_text": "I have the pills and I am taking them now. ok"},
        {"event": "voice.session.warm", "t_setup_ms": 900},
    ):
        result = service.handle_event(
            user_id_hash="usr_signed",
            payload={"session_id": grant["session_id"], **payload},
        )
        assert result["action"] != "escalate_pause", payload
        assert result.get("floor") != "crisis_freeze", payload
        record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
        assert record["status"] != "crisis_freeze", payload

    torn = service.handle_event(
        user_id_hash="usr_signed",
        payload={"session_id": grant["session_id"], "event": "voice.session.teardown", "used_s": 30},
    )
    assert torn["action"] == "torn_down"


def test_stay_support_keeps_the_session_open() -> None:
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.sync",
            "input_text": "i want to die tonight",
            "output_text": "",
        },
    )
    later = service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.floor.transition",
            "to": "speaking",
            "reason": "model_audio",
        },
    )
    assert later["action"] == "continue"
    assert later["floor"] == "speaking"
    record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
    assert record["status"] == "stay_support"
    assert record["floor"] == "speaking"


def test_same_stay_support_fingerprint_does_not_escalate() -> None:
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    first = service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.sync",
            "input_text": "i want to die tonight",
            "output_text": "",
        },
    )
    again = service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.sync",
            "input_text": "i want to die tonight",
            "output_text": "",
        },
    )
    assert first["action"] == "stay_support"
    assert again["action"] == "stay_support"
    record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
    assert record["status"] == "stay_support"


def test_repeated_distress_after_stay_support_stays() -> None:
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    first = service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.sync",
            "input_text": "i want to die tonight",
            "output_text": "",
        },
    )
    repeated = service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.sync",
            "input_text": "i want to die tonight i still want to kill myself",
            "output_text": "",
        },
    )
    assert first["action"] == "stay_support"
    assert repeated["action"] == "stay_support"
    assert repeated.get("speak_first") is not True
    record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
    assert record.get("crisis_trigger") != "repeated_intent_after_support"
    assert record["status"] == "stay_support"
    assert record.get("speak_then_pause") is not True


def test_ordinary_speech_after_stay_support_does_not_pause() -> None:
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.sync",
            "input_text": "i want to die tonight",
            "output_text": "",
        },
    )
    later = service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.sync",
            "input_text": "i want to die tonight yeah work has been really heavy",
            "output_text": "i am still here with you",
        },
    )
    assert later["action"] == "continue"
    assert later.get("terminal") is not True
    record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
    assert record["status"] == "stay_support"
    assert record["floor"] != "crisis_freeze"


def test_client_reported_freeze_is_recorded_without_a_server_side_match() -> None:
    """The client enforces on its own lexicon; the server must not argue with it."""
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    result = service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.safety.crisis",
            "reason": "local_evidence",
            "source": "local_input",
        },
    )
    assert result["action"] == "escalate_pause"
    assert "988" in result["crisis_response"]
    record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
    assert record["crisis_source"] == "local_input"
    assert record["inhibit_memory"] is True


def test_client_floor_freeze_is_terminal_server_side() -> None:
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    frozen = service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.floor.transition",
            "to": "crisis_freeze",
            "reason": "crisis_freeze",
        },
    )
    assert frozen["action"] == "escalate_pause"
    later = service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.floor.transition",
            "to": "speaking",
            "reason": "model_audio",
        },
    )
    assert later["floor"] == "crisis_freeze"


def test_absent_transcript_reports_read_as_unverified_not_safe() -> None:
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
    record["last_safety_at"] = time.time() - (SAFETY_STALE_S + 5)
    store.set_document(VOICE_SESSION_COLLECTION, grant["session_id"], record)

    stale = service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.floor.transition",
            "to": "speaking",
            "reason": "model_audio",
        },
    )
    assert stale["action"] == "continue"
    assert stale["safety_verified"] is False

    # Fail closed: no fresh credential for a client that stopped reporting.
    with pytest.raises(AppError) as exc:
        service.handle_event(
            user_id_hash="usr_signed",
            payload={"session_id": grant["session_id"], "event": "voice.session.renew"},
        )
    assert "safety check" in exc.value.message.lower()

    service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.sync",
            "input_text": "i had a long day",
            "output_text": "",
        },
    )
    renewed = service.handle_event(
        user_id_hash="usr_signed",
        payload={"session_id": grant["session_id"], "event": "voice.session.renew"},
    )
    assert renewed["token"] == "authTokens/unit"
    assert renewed["safety_verified"] is True


def test_renew_does_not_reserve_a_second_session() -> None:
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    remaining = grant["quota_remaining_s"]
    renewed = service.handle_event(
        user_id_hash="usr_signed",
        payload={"session_id": grant["session_id"], "event": "voice.session.renew"},
    )
    assert renewed["ok"] is True
    assert renewed["token"] == "authTokens/unit"
    assert renewed["session_id"] == grant["session_id"]
    assert renewed["quota_remaining_s"] == remaining
    assert renewed["session_limit_s"] == RESERVE_SECONDS


def test_teardown_is_idempotent_and_does_not_refund_twice() -> None:
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    first = service.teardown(
        user_id_hash="usr_signed",
        session_id=grant["session_id"],
        reason="client_hangup",
        used_s=0,
    )
    second = service.teardown(
        user_id_hash="usr_signed",
        session_id=grant["session_id"],
        reason="client_hangup",
        used_s=0,
    )
    assert first["action"] == "torn_down"
    assert second["already_settled"] is True
    assert second["refund_s"] == 0
    usage = store.get_document("voice_minute_reservations", "usr_signed")
    # First teardown billed server elapsed (near 0) and refunded the rest once.
    assert int(usage["used_s"]) < RESERVE_SECONDS * 2


def test_settlement_uses_server_clock_not_client_used_s() -> None:
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
    record["created_at"] = time.time() - 90
    store.set_document(VOICE_SESSION_COLLECTION, grant["session_id"], record)
    result = service.teardown(
        user_id_hash="usr_signed",
        session_id=grant["session_id"],
        reason="client_hangup",
        used_s=0,
    )
    assert result["used_s"] >= 80
    assert result["used_s"] <= RESERVE_SECONDS
    stored = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
    assert stored["client_used_s"] == 0
    assert stored["used_s"] == result["used_s"]


def test_concurrent_mint_reclaims_same_user_session() -> None:
    """Second mint for the same user replaces the prior active session (reclaim)."""
    store = InMemoryStore()
    service = _service(store)
    first = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    second = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    assert second["session_id"] != first["session_id"]
    prior = store.get_document(VOICE_SESSION_COLLECTION, first["session_id"])
    assert prior["status"] == "torn_down"
    assert prior["teardown_reason"] == "reclaimed"
    active = store.get_document("voice_active_sessions", "usr_signed")
    assert active["session_id"] == second["session_id"]
    usage = store.get_document("voice_minute_reservations", "usr_signed")
    # Prior reserve refunded (near-zero elapsed) then second reserve applied once.
    assert usage["used_s"] == RESERVE_SECONDS


def test_abandoned_unwarmed_session_does_not_block_mint() -> None:
    store = InMemoryStore()
    service = _service(store)
    first = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    record = store.get_document(VOICE_SESSION_COLLECTION, first["session_id"])
    record["created_at"] = time.time() - 180
    store.set_document(VOICE_SESSION_COLLECTION, first["session_id"], record)
    second = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    assert second["session_id"] != first["session_id"]
    prior = store.get_document(VOICE_SESSION_COLLECTION, first["session_id"])
    assert prior["status"] == "torn_down"
    assert prior["teardown_reason"] == "abandoned_unwarmed"


def test_expired_session_past_reserve_does_not_block_mint() -> None:
    store = InMemoryStore()
    service = _service(store)
    first = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    record = store.get_document(VOICE_SESSION_COLLECTION, first["session_id"])
    # Shorter reserve so reclaim settlement leaves daily minutes for a new call.
    record["reserved_s"] = 120
    record["created_at"] = time.time() - 200
    record["setup_complete"] = True
    record["last_safety_at"] = time.time() - 5
    store.set_document(VOICE_SESSION_COLLECTION, first["session_id"], record)
    usage = store.get_document("voice_minute_reservations", "usr_signed")
    usage["used_s"] = 120
    store.set_document("voice_minute_reservations", "usr_signed", usage)
    second = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    assert second["session_id"] != first["session_id"]
    prior = store.get_document(VOICE_SESSION_COLLECTION, first["session_id"])
    assert prior["teardown_reason"] == "expired_reclaim"


def test_teardown_without_session_id_clears_active() -> None:
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    result = service.handle_event(
        user_id_hash="usr_signed",
        payload={"event": "voice.session.teardown", "reason": "client_hangup"},
    )
    assert result["action"] == "torn_down"
    assert result["session_id"] == grant["session_id"]
    assert store.get_document("voice_active_sessions", "usr_signed") is None
    again = service.handle_event(
        user_id_hash="usr_signed",
        payload={"event": "voice.session.teardown", "reason": "client_hangup"},
    )
    assert again["already_settled"] is True
    assert again.get("no_active") is True
    third = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    assert third["session_id"] != grant["session_id"]


def test_renew_refuses_after_reservation_elapses() -> None:
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
    record["created_at"] = time.time() - (RESERVE_SECONDS + 5)
    store.set_document(VOICE_SESSION_COLLECTION, grant["session_id"], record)
    service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.sync",
            "input_text": "still here",
            "output_text": "",
        },
    )
    with pytest.raises(AppError) as exc:
        service.handle_event(
            user_id_hash="usr_signed",
            payload={"session_id": grant["session_id"], "event": "voice.session.renew"},
        )
    assert exc.value.code == "quota_exceeded"


def test_classifier_failure_is_unverified_not_safe() -> None:
    store = InMemoryStore()
    service = _service(store, _FakeCrisis(fail=True))
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    result = service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.sync",
            "input_text": "i want to die tonight",
            "output_text": "",
        },
    )
    assert result["action"] == "continue"
    assert result["safety_verified"] is False
    record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
    assert record.get("status") != "crisis_freeze"
    assert record.get("stay_support") is not True


def test_leftover_minutes_can_start_a_shorter_call() -> None:
    store = InMemoryStore()
    service = _service(store)
    first = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    record = store.get_document(VOICE_SESSION_COLLECTION, first["session_id"])
    record["created_at"] = time.time() - 120
    store.set_document(VOICE_SESSION_COLLECTION, first["session_id"], record)
    service.teardown(user_id_hash="usr_signed", session_id=first["session_id"], reason="client_hangup")
    usage = store.get_document("voice_minute_reservations", "usr_signed")
    leftover = DAILY_CAP_SECONDS - int(usage["used_s"])
    second = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    assert leftover < RESERVE_SECONDS
    assert leftover >= MIN_SESSION_SECONDS
    assert second["session_limit_s"] == leftover


def test_running_from_someone_trying_to_kill_me_stays_when_mocked_imminent() -> None:
    store = InMemoryStore()

    class _Imminent:
        def classify(self, input_text: str, output_text: str = "") -> VoiceSafetyVerdict:
            return VoiceSafetyVerdict(
                label=IMMINENT_ESCALATE,
                verified=True,
                trigger_reason="ai_classifier",
                crisis_response=CRISIS_RESPONSE,
                danger_kind="physical",
            )

    service = _service(store, _Imminent())
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    result = service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.sync",
            "input_text": "I'm running from someone trying to kill me",
            "output_text": "",
        },
    )
    assert result["action"] == "stay_support"
    assert result["imminent"] is True
    assert result["danger_kind"] == "physical"
    assert result["terminal"] is False
    assert result.get("floor") != "crisis_freeze"


def test_call_911_alone_does_not_pause() -> None:
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    result = service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.sync",
            "input_text": "call 911",
            "output_text": "",
        },
    )
    assert result["action"] == "continue"
    assert result.get("speak_first") is not True
    record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
    assert record.get("status") != "crisis_freeze"
    assert record.get("speak_then_pause") is not True


def test_arabic_physical_danger_stays_when_classifier_says_imminent() -> None:
    store = InMemoryStore()

    class _ArabicImminent:
        def classify(self, input_text: str, output_text: str = "") -> VoiceSafetyVerdict:
            return VoiceSafetyVerdict(
                label=IMMINENT_ESCALATE,
                verified=True,
                trigger_reason="ai_classifier",
                crisis_response=CRISIS_RESPONSE,
                danger_kind="physical",
            )

    service = _service(store, _ArabicImminent())
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    result = service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.sync",
            "input_text": "في حدا عم يحاول يقتلني وهلق عم اهرب",
            "output_text": "",
        },
    )
    assert result["action"] == "stay_support"
    assert result["imminent"] is True
    assert result["danger_kind"] == "physical"
    assert result["terminal"] is False


def test_swearing_does_not_pause_the_call() -> None:
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    for phrase in ("fuck you", "shit", "كس امك"):
        result = service.handle_event(
            user_id_hash="usr_signed",
            payload={
                "session_id": grant["session_id"],
                "event": "voice.transcript.sync",
                "input_text": phrase,
                "output_text": "",
            },
        )
        assert result["action"] == "continue", phrase
        assert result.get("speak_first") is not True
        record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
        assert record.get("status") != "crisis_freeze", phrase
        assert record.get("speak_then_pause") is not True, phrase


def test_running_from_a_killer_is_imminent_and_the_call_continues() -> None:
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    result = service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.sync",
            "input_text": "hey mindpal right now i'm running from a killer i need help",
            "output_text": "",
        },
    )
    assert result["action"] == "stay_support"
    assert result["imminent"] is True
    assert result["danger_kind"] == "physical"
    record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
    assert record["status"] == "stay_support"

    later = service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.floor.transition",
            "to": "speaking",
            "reason": "model_audio",
        },
    )
    assert later["floor"] == "speaking", "MindPal keeps talking to them"
    record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
    assert record["floor"] == "speaking"
    assert record["status"] != "crisis_freeze"


def test_want_to_die_tonight_stays_in_voice() -> None:
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    result = service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.sync",
            "input_text": "I want to die tonight",
            "output_text": "",
        },
    )
    assert result["action"] == "stay_support"
    assert result["terminal"] is False
    assert result.get("speak_first") is not True
    record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
    assert record["status"] == "stay_support"
    assert record["floor"] != "crisis_freeze"


def test_kill_myself_laughing_is_not_crisis() -> None:
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    result = service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.sync",
            "input_text": "i could kill myself laughing",
            "output_text": "",
        },
    )
    assert result["action"] == "continue"
    assert result["safety_verified"] is True


def test_joking_911_and_roast_do_not_pause() -> None:
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    for phrase in (
        "bro i'm gonna kill you that's hilarious",
        "call 911 the wifi is dead",
        "kill me that joke was so bad",
        "bro i'm gonna kill you that's hilarious call 911",
    ):
        result = service.handle_event(
            user_id_hash="usr_signed",
            payload={
                "session_id": grant["session_id"],
                "event": "voice.transcript.sync",
                "input_text": phrase,
                "output_text": "",
            },
        )
        assert result["action"] == "continue", phrase
        assert result.get("speak_first") is not True, phrase
        record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
        assert record.get("status") != "crisis_freeze", phrase
        assert record.get("speak_then_pause") is not True, phrase


def test_model_988_script_does_not_pause_a_joke() -> None:
    store = InMemoryStore()
    service = _service(
        store,
        VoiceCrisisClassifier(
            generate_json=lambda **kwargs: '{"label":"imminent_escalate","danger_kind":"self_harm"}'
        ),
    )
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    silent = service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.sync",
            "input_text": "",
            "output_text": "You can call 988 or text HOME to 741741.",
        },
    )
    assert silent["action"] == "continue"
    assert silent.get("speak_first") is not True
    record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
    assert record.get("speak_then_pause") is not True
    assert record.get("status") != "crisis_freeze"


def test_a_false_imminent_never_froze_anything_to_undo() -> None:
    """The old P0: a later non-imminent classify cleared a pending pause.

    With no pause there is nothing to clear or race. The call simply stays in
    support mode and was never frozen at any point.
    """
    store = InMemoryStore()

    class _Flip:
        n = 0

        def classify(self, input_text: str, output_text: str = "") -> VoiceSafetyVerdict:
            self.n += 1
            if self.n == 1:
                return VoiceSafetyVerdict(
                    label=IMMINENT_ESCALATE,
                    verified=True,
                    trigger_reason="ai_classifier",
                    crisis_response=CRISIS_RESPONSE,
                    danger_kind="unspecified",
                )
            return VoiceSafetyVerdict(label=NOT_CRISIS, verified=True)

    service = _service(store, _Flip())
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    first = service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.sync",
            "input_text": "bro i'm gonna kill you",
            "output_text": "",
        },
    )
    assert first["action"] == "stay_support"
    service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.sync",
            "input_text": "bro i'm gonna kill you wait that was a joke",
            "output_text": "",
        },
    )
    record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
    assert record.get("speak_then_pause") is not True
    assert record.get("status") != "crisis_freeze"


def test_renew_refuses_when_flag_is_off() -> None:
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    service.flags = FeatureLifecycleEngine(
        registry=[FeatureDefinition(key="voice.realtime", stage=FeatureStage.DARK_LAUNCH)]
    )
    with pytest.raises(AppError) as exc:
        service.handle_event(
            user_id_hash="usr_signed",
            payload={"session_id": grant["session_id"], "event": "voice.session.renew"},
        )
    assert exc.value.code == "forbidden"


def test_provider_rotate_stays_off_unless_env_sets_a_measured_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    store = InMemoryStore()
    monkeypatch.delenv("MINDPAL_VOICE_PROVIDER_ROTATE_S", raising=False)
    grant = _service(store).mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    assert "provider_rotate_s" not in grant
    monkeypatch.setenv("MINDPAL_VOICE_PROVIDER_ROTATE_S", "840")
    opted = _service(InMemoryStore()).mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    assert opted["provider_rotate_s"] == 840
    assert opted["session_limit_s"] == RESERVE_SECONDS


def test_transcript_deltas_keep_a_longer_ledger_than_the_safety_window() -> None:
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    spoken = "yesterday at work " * 80
    service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.in_delta",
            "text": spoken,
            "is_final": True,
        },
    )
    record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
    assert len(record["input_ledger"]) > len(record["input_transcript"])
    assert "yesterday at work" in record["input_ledger"]


class _CountingCrisis(_FakeCrisis):
    def __init__(self) -> None:
        super().__init__()
        self.calls = 0

    def classify(self, input_text: str, output_text: str = "") -> VoiceSafetyVerdict:
        self.calls += 1
        return super().classify(input_text, output_text)


def test_classify_skips_model_only_and_unchanged_heartbeats() -> None:
    store = InMemoryStore()
    crisis = _CountingCrisis()
    service = _service(store, crisis=crisis)
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    first = service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.sync",
            "input_text": "work has been heavy this week",
            "output_text": "",
            "is_final": True,
        },
    )
    assert first["action"] == "continue"
    assert crisis.calls == 1

    model_only = service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.sync",
            "input_text": "work has been heavy this week",
            "output_text": "that sounds exhausting",
            "is_final": False,
        },
    )
    assert model_only["action"] == "continue"
    assert crisis.calls == 1
    assert model_only.get("gemini_classify_skips", 0) >= 1

    heartbeat = service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.sync",
            "input_text": "work has been heavy this week",
            "output_text": "that sounds exhausting",
        },
    )
    assert heartbeat["safety_verified"] is True
    assert crisis.calls == 1


def test_classify_debounce_holds_partials_until_final(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(gemini_budget_mod, "CLASSIFY_MIN_INTERVAL_S", 10.0)
    monkeypatch.setattr(gemini_budget_mod, "CLASSIFY_FINAL_MIN_INTERVAL_S", 2.5)
    store = InMemoryStore()
    crisis = _CountingCrisis()
    service = _service(store, crisis=crisis)
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)

    service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.sync",
            "input_text": "lets talk about the weather today",
            "output_text": "",
            "is_final": True,
        },
    )
    assert crisis.calls == 1

    for text in ("i", "i want", "i want to", "i want to die someday"):
        service.handle_event(
            user_id_hash="usr_signed",
            payload={
                "session_id": grant["session_id"],
                "event": "voice.transcript.sync",
                "input_text": text,
                "output_text": "",
                "is_final": False,
            },
        )
    # Partials under min-interval must not storm Gemini even with growing text.
    assert crisis.calls == 1

    record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
    record["last_classify_at"] = time.time() - 3.0
    store.set_document(VOICE_SESSION_COLLECTION, grant["session_id"], record)

    stayed = service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.sync",
            "input_text": "i want to die someday",
            "output_text": "",
            "is_final": True,
        },
    )
    assert crisis.calls == 2
    assert stayed["action"] == "stay_support"


def test_should_run_classify_gate_unit() -> None:
    assert should_run_classify(
        input_text="",
        output_text="hello",
        prior_input="",
        prior_fingerprint="",
        last_classify_at=0,
        is_final=False,
    ).reason == "no_user_speech"
    assert should_run_classify(
        input_text="same",
        output_text="new model",
        prior_input="same",
        prior_fingerprint="same\nold",
        last_classify_at=0,
        is_final=False,
    ).reason == "model_only"
    held = should_run_classify(
        input_text="a longer partial utterance here",
        output_text="",
        prior_input="a longer",
        prior_fingerprint="a longer\n",
        last_classify_at=time.time(),
        is_final=False,
        min_interval_s=10,
        final_min_interval_s=2,
    )
    assert held.run is False
    assert held.reason == "min_interval"
    final = should_run_classify(
        input_text="a longer partial utterance here",
        output_text="",
        prior_input="a longer",
        prior_fingerprint="a longer\n",
        last_classify_at=time.time() - 3,
        is_final=True,
        min_interval_s=10,
        final_min_interval_s=2,
    )
    assert final.run is True


def test_working_memory_persists_on_sync() -> None:
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_signed", is_authenticated=True, consent_attested=True)
    service.handle_event(
        user_id_hash="usr_signed",
        payload={
            "session_id": grant["session_id"],
            "event": "voice.transcript.sync",
            "input_text": "my brother moved last week",
            "output_text": "",
            "is_final": True,
            "working_memory": {
                "topics": ["brother moving"],
                "open_questions": ["how are you settling?"],
                "user_facts_this_session": ["has a brother"],
                "last_user_intent": "my brother moved last week",
                "edges": [{"from": "family", "to": "brother moving", "rel": "follows_from"}],
                "timeline": [{"role": "user", "summary": "my brother moved last week"}],
            },
        },
    )
    record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
    memory = record["working_memory"]
    assert "brother moving" in memory["topics"]
    assert memory["user_facts_this_session"][0] == "has a brother"
    assert memory["edges"][0]["rel"] == "follows_from"


def test_usage_snapshot_reports_voice_budget_separately_from_chat(monkeypatch) -> None:
    """Settings said "No usage yet" to someone who had spent their whole voice
    allowance, because that screen only ever read the chat quota. Voice is a
    different pool and needs its own read-only view."""
    service = VoiceSessionService(store=InMemoryStore())

    empty = service.usage_snapshot(user_id_hash="usr_1")
    assert empty["used_s"] == 0
    assert empty["cap_s"] > 0
    assert empty["remaining_s"] == empty["cap_s"]
    assert empty["in_call"] is False

    # Spend some of the budget the same way a mint does.
    usage = service._usage("usr_1")
    usage["used_s"] = 600
    service.store.set_document(VOICE_USAGE_COLLECTION, "usr_1", usage)

    after = service.usage_snapshot(user_id_hash="usr_1")
    assert after["used_s"] == 600
    assert after["remaining_s"] == after["cap_s"] - 600
    # Read-only: asking must never consume budget.
    assert service.usage_snapshot(user_id_hash="usr_1")["used_s"] == 600


def test_usage_snapshot_never_reports_more_used_than_the_cap() -> None:
    service = VoiceSessionService(store=InMemoryStore())
    usage = service._usage("usr_2")
    usage["used_s"] = 99_999
    service.store.set_document(VOICE_USAGE_COLLECTION, "usr_2", usage)

    snapshot = service.usage_snapshot(user_id_hash="usr_2")
    assert snapshot["used_s"] == snapshot["cap_s"], "a progress bar must not exceed 100%"
    assert snapshot["remaining_s"] == 0


def test_mint_does_not_report_the_day_as_used_up_while_starting_a_call() -> None:
    """A trace showed `quotaRemainingS: 0` on a grant for a 1800s session.

    RESERVE_SECONDS equals DAILY_CAP_SECONDS, so the first mint of the day holds
    the whole allowance; reporting the post-hold figure told the caller their
    minutes were gone at the instant a full-length call began.
    """
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_q", is_authenticated=True, consent_attested=True)

    assert grant["session_limit_s"] == RESERVE_SECONDS
    assert grant["quota_remaining_s"] > 0, "a full-length session is not a used-up day"
    assert grant["quota_remaining_s"] == DAILY_CAP_SECONDS


def test_usage_snapshot_does_not_count_a_live_call_as_fully_spent() -> None:
    """Settings said the whole allowance was gone the moment a call started.

    The hold is refunded at teardown, so only what the call has actually spent
    so far belongs in the number the caller reads.
    """
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_live", is_authenticated=True, consent_attested=True)

    snapshot = service.usage_snapshot(user_id_hash="usr_live")
    assert snapshot["in_call"] is True
    assert snapshot["used_s"] < 60, "a call seconds old has not spent half an hour"
    assert snapshot["remaining_s"] > DAILY_CAP_SECONDS - 60

    # Wind the call back so it has genuinely been running for ten minutes.
    record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
    record["created_at"] = time.time() - 600
    store.set_document(VOICE_SESSION_COLLECTION, grant["session_id"], record)

    mid_call = service.usage_snapshot(user_id_hash="usr_live")
    assert 595 <= mid_call["used_s"] <= 605, "ten minutes of talking is ten minutes of budget"
    assert mid_call["remaining_s"] == DAILY_CAP_SECONDS - mid_call["used_s"]


def test_usage_snapshot_counts_the_call_once_it_is_settled() -> None:
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_done", is_authenticated=True, consent_attested=True)
    record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
    record["created_at"] = time.time() - 300
    store.set_document(VOICE_SESSION_COLLECTION, grant["session_id"], record)

    service.teardown(
        user_id_hash="usr_done",
        session_id=grant["session_id"],
        reason="client_hangup",
        used_s=300,
    )

    settled = service.usage_snapshot(user_id_hash="usr_done")
    assert settled["in_call"] is False
    assert 295 <= settled["used_s"] <= 305, "the five minutes actually spent, not the hold"
    assert settled["remaining_s"] >= DAILY_CAP_SECONDS - 305


def test_usage_snapshot_does_not_show_an_abandoned_call_as_still_running() -> None:
    """A crashed tab or a backend restarted mid-call never tears down.

    The active pointer survives, and settings went on claiming a live call was
    in progress long after it ended. The next mint reclaims and refunds it; this
    screen must not report it as live in the meantime.
    """
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_lost", is_authenticated=True, consent_attested=True)
    record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
    # Started 40 minutes ago; the last transcript sync was two minutes in, then
    # the tab died and nothing ever tore the session down.
    started = time.time() - (RESERVE_SECONDS + 600)
    record["created_at"] = started
    record["last_safety_at"] = started + 120
    record["last_classify_at"] = started + 120
    store.set_document(VOICE_SESSION_COLLECTION, grant["session_id"], record)

    snapshot = service.usage_snapshot(user_id_hash="usr_lost")
    assert snapshot["in_call"] is False, "a call that outlived its reservation is over"

    # Minting again reclaims it, and bills the two minutes it actually ran -
    # not the whole reservation, which would cost a crashed tab the entire day.
    service.mint(user_id_hash="usr_lost", is_authenticated=True, consent_attested=True)
    settled = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
    assert settled["status"] == "torn_down"
    assert 115 <= settled["used_s"] <= 125, f"billed {settled['used_s']}s for a two minute call"


def test_abandoned_call_is_billed_for_what_it_ran_not_the_whole_hold() -> None:
    """A tab that crashes two minutes in must not cost the day.

    Reclaim has no caller to say when the call ended, so wall clock is the wrong
    meter: the reservation is the entire daily cap, and billing it in full is
    how one short call produced "Today's live voice minutes are used up".
    """
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_crash", is_authenticated=True, consent_attested=True)
    session_id = grant["session_id"]

    # The call ran for two minutes, sending floor events only - no transcripts.
    service.handle_event(
        user_id_hash="usr_crash",
        payload={"session_id": session_id, "event": "voice.session.warm", "t_setup_ms": 900},
    )
    record = store.get_document(VOICE_SESSION_COLLECTION, session_id)
    started = time.time() - (RESERVE_SECONDS + 900)
    record["created_at"] = started
    record["last_safety_at"] = started
    record["last_classify_at"] = 0.0
    record["last_event_at"] = started + 120
    store.set_document(VOICE_SESSION_COLLECTION, session_id, record)

    service.mint(user_id_hash="usr_crash", is_authenticated=True, consent_attested=True)

    settled = store.get_document(VOICE_SESSION_COLLECTION, session_id)
    assert settled["status"] == "torn_down"
    assert 115 <= settled["used_s"] <= 125, f"billed {settled['used_s']}s for two minutes"
    snapshot = service.usage_snapshot(user_id_hash="usr_crash")
    assert snapshot["remaining_s"] > DAILY_CAP_SECONDS - 300, "the day survives a crashed tab"


def test_a_real_hangup_is_still_billed_by_the_server_clock() -> None:
    """The reclaim meter must not become a way to under-report a live call."""
    store = InMemoryStore()
    service = _service(store)
    grant = service.mint(user_id_hash="usr_honest", is_authenticated=True, consent_attested=True)
    record = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
    # Ten minutes of call, but the last server-side stamp was minutes ago.
    started = time.time() - 600
    record["created_at"] = started
    record["last_safety_at"] = started + 60
    record["last_event_at"] = started + 60
    store.set_document(VOICE_SESSION_COLLECTION, grant["session_id"], record)

    service.teardown(
        user_id_hash="usr_honest",
        session_id=grant["session_id"],
        reason="client_hangup",
        used_s=1,
    )
    settled = store.get_document(VOICE_SESSION_COLLECTION, grant["session_id"])
    assert 595 <= settled["used_s"] <= 605, "a caller hanging up is billed for the call they had"
