"""AI memory consolidation (collect -> compact -> summarize) and load-aware policy."""

from __future__ import annotations

import json
from typing import Any, List

import pytest

from backend.domain.dynamic.policy import LoadState, current_load, level_for, pressure_from
from backend.domain.memory.consolidation import (
    JOBS_COLLECTION,
    JOURNAL_COLLECTION,
    MemoryConsolidationService,
)
from backend.domain.memory.graph import MemoryAtom, MemoryGraphService
from backend.infra.observability.pulse import PlatformPulse
from backend.infra.store.providers.memory import InMemoryStore

USER = "usr_consolidation"


class _Clock:
    def __init__(self, now: float = 1_800_000_000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class _FakeModel:
    """Answers digest and summary prompts; records every call (the AI 'usage')."""

    def __init__(self) -> None:
        self.calls: List[dict] = []

    def __call__(self, **kwargs: Any) -> str:
        self.calls.append(kwargs)
        if "memory digest" in kwargs["system_instruction"]:
            return '```json\n{"digest": "They talked about exam stress; a walk helped.", "themes": ["exams"], "helped": ["walk"]}\n```'
        return json.dumps({"summary": "Preparing for exams and stressed; walks help.", "open_threads": ["exam on Friday"]})


def _load(level: str):
    return lambda: LoadState(level=level, pressure=0.0, drivers={}, pulse=None, overridden=True)


def _service(level: str = "calm", clock: _Clock | None = None):
    store = InMemoryStore()
    model = _FakeModel()
    clock = clock or _Clock()
    service = MemoryConsolidationService(store, generate_json=model, load=_load(level), clock=clock)
    return service, store, model, clock


def _chat(service: MemoryConsolidationService, turns: int, text: str = "Exams are stressing me out a lot") -> bool:
    due = False
    for index in range(turns):
        due = service.record_turn(USER, f"{text} ({index})", "That sounds heavy. What helps?")
    return due


# -- the pipeline --------------------------------------------------------------


def test_no_ai_call_happens_per_turn() -> None:
    service, store, model, _ = _service()
    assert _chat(service, 5) is False  # calm threshold is 6 turns
    assert model.calls == []
    assert store.get_document(JOBS_COLLECTION, USER) is None


def test_first_consolidation_compacts_and_writes_the_first_summary() -> None:
    service, store, model, _ = _service()
    assert _chat(service, 6) is True
    assert store.get_document(JOBS_COLLECTION, USER) is not None

    report = service.run(USER)
    # The first consolidation also writes the person's first summary (2 calls, once).
    assert report.compacted and report.summarized and len(model.calls) == 2
    journal = store.get_document(JOURNAL_COLLECTION, USER)
    assert journal["turns"] == []  # raw turns deleted after compaction
    assert journal["digests"][0]["text"].startswith("They talked about exam stress")


def test_summary_is_written_and_used_in_the_chat_prompt() -> None:
    clock = _Clock()
    service, store, model, _ = _service(clock=clock)
    service.add_digest(USER, "In a voice call: they described a rough week at work.", source="voice")
    _chat(service, 6)
    report = service.run(USER)
    assert report.compacted and report.summarized and len(model.calls) == 2

    memory = MemoryGraphService(store)
    graph = memory.get_memory_graph(USER)
    assert graph.narrative == "Preparing for exams and stressed; walks help."
    assert graph.open_threads == ["exam on Friday"]
    prompt = memory.prompt_for_user(USER).text
    assert "Ongoing context" in prompt and "exam on Friday" in prompt
    assert store.get_document(JOBS_COLLECTION, USER) is None


def test_voice_recaps_become_digests_for_free() -> None:
    service, store, model, _ = _service()
    service.add_digest(USER, "In a voice call: they shared that sleep has been better.")
    assert model.calls == []
    assert store.get_document(JOURNAL_COLLECTION, USER)["digests"][0]["source"] == "voice"


def test_crisis_turns_never_enter_the_journal() -> None:
    service, store, _, _ = _service()
    service.record_turn(USER, "I want to kill myself", "…")
    assert store.get_document(JOURNAL_COLLECTION, USER) is None


def test_cooldown_and_daily_budget_cap_ai_usage() -> None:
    clock = _Clock()
    service, store, model, _ = _service(clock=clock)
    _chat(service, 6)
    service.run(USER)
    calls_after_first = len(model.calls)
    _chat(service, 6)
    assert service.run(USER).skipped == "cooldown"  # calm cooldown is 4h
    assert len(model.calls) == calls_after_first

    # A very chatty person, with the cooldown elapsed every time: the daily
    # budget (calm: 6 AI calls per UTC day) still caps usage.
    import time as _time

    per_day: dict[str, int] = {}
    for _ in range(12):
        clock.advance(4 * 3600 + 1)
        _chat(service, 6)
        before = len(model.calls)
        service.run(USER)
        day = _time.strftime("%Y-%m-%d", _time.gmtime(clock()))
        per_day[day] = per_day.get(day, 0) + len(model.calls) - before
    assert max(per_day.values()) <= 6
    assert store.get_document(JOURNAL_COLLECTION, USER)["ai_calls"]["count"] <= 6


def test_idle_conversation_is_compacted_without_reaching_the_turn_threshold() -> None:
    clock = _Clock()
    service, _, _, _ = _service(clock=clock)
    _chat(service, 3)
    assert service.run(USER).skipped == "not_due"
    clock.advance(31 * 60)
    assert service.run(USER).compacted


# -- load awareness ------------------------------------------------------------


def test_busy_platform_raises_thresholds() -> None:
    service, _, model, _ = _service(level="busy")
    assert _chat(service, 6) is False  # busy needs 10 turns
    assert _chat(service, 4) is True


def test_critical_load_defers_ai_work_to_the_scheduler() -> None:
    clock = _Clock()
    service, store, model, _ = _service(level="critical", clock=clock)
    _chat(service, 24)
    assert service.run(USER).skipped == "load_critical"
    assert model.calls == []
    assert store.get_document(JOBS_COLLECTION, USER) is not None

    assert service.run_due()["processed"] == 0  # critical batch is 0...
    clock.advance(49 * 3600)
    assert service.run_due()["processed"] == 1  # ...but overdue work still runs
    assert model.calls


def test_person_requested_summary_runs_even_during_cooldown() -> None:
    service, store, model, _ = _service()
    _chat(service, 6)
    service.run(USER)
    before = len(model.calls)
    service.request_summary(USER)
    assert service.run(USER, force=True).summarized
    assert len(model.calls) == before + 1


# -- privacy -------------------------------------------------------------------


def test_deleting_a_fact_scrubs_it_from_ai_memory() -> None:
    service, store, _, _ = _service()
    service.add_digest(USER, "They work at Acme and find it draining.")
    service.add_digest(USER, "They enjoy evening walks.")
    memory = MemoryGraphService(store)
    graph = memory.get_memory_graph(USER)
    graph.narrative = "Works at Acme; enjoys walks."
    memory.save_memory_graph(graph)

    service.forget_facts(USER, ["Works at: Acme"])
    assert memory.get_memory_graph(USER).narrative == ""
    digests = [d["text"] for d in store.get_document(JOURNAL_COLLECTION, USER)["digests"]]
    assert digests == ["They enjoy evening walks."]
    assert store.get_document(JOBS_COLLECTION, USER)["reason"] == "facts_deleted"


def test_forget_removes_summary_digests_and_queue() -> None:
    service, store, _, _ = _service()
    _chat(service, 6)
    service.run(USER)
    service.forget(USER)
    assert MemoryGraphService(store).get_memory_graph(USER).narrative == ""
    assert store.get_document(JOURNAL_COLLECTION, USER) is None
    assert store.get_document(JOBS_COLLECTION, USER) is None


def test_saving_unchanged_facts_keeps_the_ai_summary_but_a_correction_drops_it() -> None:
    """A correction invalidates the AI summary (audit MP-14): it may restate the
    old wording. Saving the same facts back must not throw the summary away."""
    from fastapi.testclient import TestClient

    from backend.http import memory as memory_http
    from backend.main import create_app

    user = "usr_keepnarrative"
    service = memory_http.memory_service
    service.merge_atoms(user, [MemoryAtom(id="facts:tea", category="facts", value="Likes tea")])
    graph = service.get_memory_graph(user)
    graph.narrative = "Enjoys tea and quiet evenings."
    service.save_memory_graph(graph)

    client = TestClient(create_app(serve_frontend=False))
    headers = {"Authorization": "Bearer dev_keepnarrative"}
    unchanged = client.put("/api/memory/graph", headers=headers,
                           json={"atoms": [{"id": "facts:tea", "category": "facts", "value": "Likes tea"}]})
    assert unchanged.status_code == 200
    assert service.get_memory_graph(user).narrative == "Enjoys tea and quiet evenings."
    assert client.get("/api/memory/summary", headers=headers).json()["source"] == "ai"

    corrected = client.put("/api/memory/graph", headers=headers,
                           json={"atoms": [{"id": "facts:tea", "category": "facts", "value": "Likes green tea"}]})
    assert corrected.status_code == 200
    assert service.get_memory_graph(user).narrative == ""
    assert client.get("/api/memory/summary", headers=headers).json()["source"] != "ai"


# -- platform pulse ------------------------------------------------------------


def test_pulse_merges_instances_and_counts_people_once() -> None:
    store = InMemoryStore()
    clock = _Clock()
    first = PlatformPulse(store_factory=lambda: store, clock=clock)
    first.record_activity("usr_a")
    first.record_activity("usr_b")
    first.flush()
    # A second instance: simulate by writing its bucket document directly.
    from backend.infra.observability import pulse as pulse_module

    bucket = pulse_module.minute_bucket(clock())
    store.set_document(
        pulse_module.PULSE_COLLECTION,
        f"{bucket}:other",
        {"instance": "other", "users": [pulse_module._person_token("usr_b"), pulse_module._person_token("usr_c")],
         "requests": 2, "llm_calls": 10, "llm_failures": 1, "llm_rate_limited": 0, "llm_latency_ms": 20000, "tokens": 0},
    )
    snap = first.snapshot(fresh=True)
    assert snap.active_users == 3  # usr_b counted once across instances
    assert snap.instances == 2
    assert snap.llm_error_ratio == 0.1


def test_pulse_survives_a_storage_outage() -> None:
    def broken() -> Any:
        raise RuntimeError("down")

    pulse = PlatformPulse(store_factory=broken)
    pulse.record_activity("usr_a")
    assert pulse.flush() == 0
    snap = pulse.snapshot(fresh=True)
    assert snap.source == "local" and snap.active_users == 1


def test_pressure_levels_follow_the_busiest_signal() -> None:
    quiet = PlatformPulse(store_factory=InMemoryStore).snapshot(fresh=True)
    assert level_for(pressure_from(quiet)[0]) == "calm"
    store = InMemoryStore()
    pulse = PlatformPulse(store_factory=lambda: store)
    for index in range(40):
        pulse.record_llm(success=True, latency_ms=500, rate_limited=index % 10 == 0)
    pressure, drivers = pressure_from(pulse.snapshot(fresh=True))
    assert drivers["llm_rate_limits"] > 1
    assert level_for(pressure) == "critical"


def test_pressure_override_pins_the_level(monkeypatch) -> None:
    monkeypatch.setenv("MINDPAL_PRESSURE_OVERRIDE", "strained")
    state = current_load()
    assert state.level == "strained" and state.overridden


# -- load-aware consumers ------------------------------------------------------


def test_guests_shed_quota_under_load_but_accounts_do_not(monkeypatch) -> None:
    from backend.domain.quota.quota import ANON_LIMIT_5H, LIMIT_5H, QuotaService

    quota = QuotaService(store=InMemoryStore())
    monkeypatch.setenv("MINDPAL_PRESSURE_OVERRIDE", "critical")
    anon_5h, _ = quota._limits(anonymous=True)
    user_5h, _ = quota._limits(anonymous=False)
    assert anon_5h < ANON_LIMIT_5H
    assert user_5h == LIMIT_5H


def test_face_reactions_pause_at_critical_load(monkeypatch) -> None:
    from backend.domain.voice.services.reaction import VoiceReactionService

    calls: List[dict] = []
    service = VoiceReactionService(generate_json=lambda **k: (calls.append(k), '{"reaction":"smile"}')[1])
    monkeypatch.setenv("MINDPAL_PRESSURE_OVERRIDE", "critical")
    assert service.classify(user_id_hash="u", text="I got the job!") == "none"
    assert calls == []


def test_crisis_detection_is_never_throttled_by_load(monkeypatch) -> None:
    from backend.domain.safety.modes.chat.classify import SafetyService
    from backend.domain.safety.modes.voice.classify import VoiceCrisisClassifier

    monkeypatch.setenv("MINDPAL_PRESSURE_OVERRIDE", "critical")
    assert SafetyService().classify_message("I want to kill myself").is_crisis

    class _Budget:
        def try_acquire(self) -> bool:
            return True

        def release(self, recorded: bool) -> None:
            pass

    verdict = VoiceCrisisClassifier(
        generate_json=lambda **k: '{"label":"imminent_escalate","danger_kind":"self_harm"}', budget=_Budget()
    ).classify("I have the pills in my hand right now")
    assert verdict.is_imminent


def test_ops_endpoints_require_their_credentials(monkeypatch) -> None:
    from fastapi.testclient import TestClient

    from backend.main import create_app

    monkeypatch.setenv("CRON_SECRET", "cron-s3cret")
    monkeypatch.setenv("MINDPAL_VOICE_SUPPORT_DIAGNOSTICS_SECRET", "support-s3cret")
    client = TestClient(create_app(serve_frontend=False))
    assert client.get("/api/internal/memory-consolidation").status_code == 401
    ok = client.get("/api/internal/memory-consolidation", headers={"Authorization": "Bearer cron-s3cret"})
    assert ok.status_code == 200 and "level" in ok.json()
    assert client.get("/api/internal/platform-pulse").status_code == 401
    pulse = client.get("/api/internal/platform-pulse", headers={"X-Voice-Support-Secret": "support-s3cret"})
    assert pulse.status_code == 200 and pulse.json()["level"] in {"calm", "busy", "strained", "critical"}


@pytest.mark.parametrize("level", ["calm", "busy", "strained", "critical"])
def test_every_level_has_a_complete_policy(level: str) -> None:
    state = LoadState(level=level, pressure=0.0, drivers={}, pulse=None)
    for area in ("memory", "voice_reaction", "chat", "quota"):
        assert state.policy(area)


def test_later_digests_wait_for_the_summary_threshold() -> None:
    clock = _Clock()
    service, _, model, _ = _service(clock=clock)
    _chat(service, 6)
    service.run(USER)  # first summary exists now
    clock.advance(5 * 3600)
    _chat(service, 6)
    report = service.run(USER)
    # One new digest (calm threshold: 2) and few facts: compaction only, one call.
    assert report.compacted and not report.summarized and report.ai_calls == 1


@pytest.mark.parametrize(
    ("message", "expected"),
    [
        ("my mom keeps asking about grades", []),
        ("my brother always ignores me", []),
        ("my mom Layla is visiting", ["Mother is Layla"]),
        ("my friend is called sam", ["Friend is sam"]),
        ("my wife is named Dana", ["Wife is Dana"]),
    ],
)
def test_person_facts_need_a_real_name(message: str, expected: list[str]) -> None:
    from backend.domain.memory.extract import extract_atoms_from_turn

    assert [a.value for a in extract_atoms_from_turn(message) if a.category == "people"] == expected
