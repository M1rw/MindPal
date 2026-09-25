"""Memory consolidation: collect, compact, and summarize, with AI but not per turn.

Pipeline (signed-in accounts only; crisis turns never enter it):

1. Collect. After each normal chat turn, a clipped (user, reply) pair is
   appended to `memory_journal/{user}`. Voice call recaps, already written by
   the voice summarizer, are added as ready-made digests at no extra cost.
2. Compact. Once enough turns have piled up (or the conversation went idle),
   ONE json-model call turns them into a short digest (what they shared, how
   it felt, what helped). The raw turns are then deleted: only the digest is
   kept.
3. Summarize. Once enough new digests or new facts have accumulated, ONE call
   rewrites the running narrative from the previous narrative, the most
   salient facts, and the recent digests. It is stored on the memory graph
   (`narrative`, `open_threads`) and used in chat prompts.

AI calls are rationed three ways: thresholds (turns, digests, facts), a
per-person cooldown and daily budget, and the platform load level
(`backend.domain.dynamic.policy`): when MindPal is busy the thresholds rise,
inline work stops, and the scheduler's batch shrinks. At `critical` only jobs
waiting longer than `max_defer_hours` run.

Work runs either inline after a reply (when load allows) or from the
scheduler (`/api/internal/memory-consolidation`). `memory_jobs/{user}` is the
de-duplicated queue.
"""

from __future__ import annotations

import logging
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from backend.configs.runtime import dynamic_config
from backend.domain.dynamic.policy import LoadState, current_load
from backend.domain.identity.fence import deleted_since
from backend.domain.memory.graph import NO_WRITE, MemoryAtom, MemoryGraphService, rank_atoms
from backend.domain.safety.modes.chat.classify import crisis_evidence
from backend.models.provider_outputs import MemoryDigestOutput, MemorySummaryOutput, parse_provider_output

logger = logging.getLogger("mindpal.memory.consolidation")

JOURNAL_COLLECTION = "memory_journal"
JOBS_COLLECTION = "memory_jobs"

GenerateJson = Callable[..., str]

# One consolidation run per person at a time (audit MP-11). Two runs started
# together (inline after a reply plus the scheduler, or two quick replies) both
# passed the budget check, both paid for a model call, and the first to finish
# deleted a job the other had just re-queued. A run now takes a lease on the
# journal and reserves its model calls in the same transaction.
RUN_LEASE_SECONDS = 600
MAX_AI_CALLS_PER_RUN = 2
# The scheduler's run stops starting new jobs after this long, well inside the
# function's 60s limit (vercel.json), so a slow model day ends the batch
# cleanly instead of being killed mid-write (audit MP-24). What is left waits
# for the next run.
CRON_TIME_BUDGET_S = 45.0
# A job that keeps failing backs off (15 min, 30, 60 ... up to 12 h) instead of
# being retried first every run and starving the queue behind it.
RETRY_BASE_S = 15 * 60
RETRY_MAX_S = 12 * 3600

DIGEST_SYSTEM = (
    "You compact a wellness companion's conversation turns into a private memory digest for "
    "the same person's future conversations. Use ONLY what the turns say; never invent. "
    "Write in third person, plain language, no diagnosis, no clinical labels, no quotes. "
    "Never include details of self-harm methods or means. "
    "Also list durable facts about the person worth remembering (their name, people in their life, "
    "work or studies, goals, ongoing situations, preferences), in the language they used. "
    "Skip passing moods, anything about self-harm, and anything uncertain. "
    'Return JSON only: {"digest": "<= {words} words: what they shared, how it felt, what helped or did not", '
    '"themes": ["<= 3 short topics"], "helped": ["<= 2 things that helped, if any"], '
    '"facts": [{"category": "profile|people|work|goals|situations|preferences", "value": "<= 12 words"}]}'
)

SUMMARY_SYSTEM = (
    "You maintain a short running summary that helps a wellness companion remember a person "
    "across conversations. Merge the previous summary with the new digests and saved facts. "
    "Prefer recent information when things changed; drop what is no longer relevant. "
    "Use ONLY the provided material; never invent. Third person, warm but factual, no diagnosis, "
    "no clinical labels, never self-harm method details. "
    "Open threads are things worth gently following up next time, each written as one short, warm "
    "question to the person, in the language they use (for example: How did the Friday exam go?). "
    "Never make a thread about self-harm or crisis. "
    "When a thread is about something that happens on a known day (an exam, an interview, a trip, a "
    "doctor's visit), give the date to ask after, the day after it happens, as YYYY-MM-DD, using today's "
    "date given with the material; otherwise leave after as null. "
    'Return JSON only: {"summary": "<= {words} words", '
    '"open_threads": [{"question": "<= 3 follow-up questions", "after": "YYYY-MM-DD or null"}]}'
)


def _memory_limits() -> Dict[str, Any]:
    return dynamic_config()["memory"]


def _clip(text: str, limit: int) -> str:
    value = " ".join(str(text or "").split())
    return value if len(value) <= limit else value[: max(0, limit - 1)].rstrip() + "…"


_CONTACT = re.compile(r"(?i)[A-Z0-9._%+-]+@[A-Z0-9.-]+[.][A-Z]{2,}|[+]?[0-9][0-9 ()-]{7,}[0-9]")


def _slug(value: str) -> str:
    text = re.sub(r"[^0-9a-z" + chr(0x0600) + "-" + chr(0x06FF) + r"]+", "-", value.lower()).strip("-")
    return text[:48] or "fact"


def _fact_needle(value: str) -> str:
    """The distinctive part of a fact ("Works at: Acme Corp" -> "acme corp")."""
    text = str(value or "").split(":", 1)[-1].strip().lower()
    return text if len(text) >= 3 else ""


def _fact_needles(value: str) -> List[str]:
    """Everything that identifies a fact in AI-written text.

    The whole value, plus its proper nouns: a free-text fact ("Lives in Paris")
    is paraphrased in digests ("life in Paris"), so the full sentence alone
    missed it and a corrected fact kept surfacing (audit MP-14). Only
    capitalised words after the first are used, so everyday words ("work",
    "sleep") never wipe unrelated digests.
    """
    needles = [n for n in [_fact_needle(value)] if n]
    if ":" in str(value or ""):
        return needles  # "Label: value" already names exactly what to look for
    words = str(value or "").split()
    for word in words[1:]:
        token = word.strip(".,;!?\"'()")
        if len(token) >= 3 and token[:1].isupper():
            needles.append(token.lower())
    return list(dict.fromkeys(needles))


def _today(now: float) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(now))


def empty_journal(user_id_hash: str) -> Dict[str, Any]:
    return {
        "user_id_hash": user_id_hash,
        "turns": [],
        "digests": [],
        "digests_since_summary": 0,
        "facts_since_summary": 0,
        "last_turn_at": 0.0,
        "last_ai_at": 0.0,
        "last_summary_at": 0.0,
        "ai_calls": {"day": "", "count": 0},
        "summary_requested": False,
        # {"token", "until"} while a run owns this person's consolidation.
        "lease": None,
    }


def _journal(raw: Any, user_id_hash: str) -> Dict[str, Any]:
    journal = empty_journal(user_id_hash)
    if isinstance(raw, dict):
        for key in journal:
            if key in raw:
                journal[key] = raw[key]
    journal["turns"] = [t for t in journal.get("turns") or [] if isinstance(t, dict)]
    journal["digests"] = [d for d in journal.get("digests") or [] if isinstance(d, dict)]
    if not isinstance(journal.get("ai_calls"), dict):
        journal["ai_calls"] = {"day": "", "count": 0}
    return journal


@dataclass
class DueWork:
    compact: bool = False
    summarize: bool = False
    reasons: List[str] = field(default_factory=list)

    @property
    def any(self) -> bool:
        return self.compact or self.summarize


def due_work(journal: Dict[str, Any], memory_policy: Dict[str, Any], *, now: float, force: bool = False) -> DueWork:
    """What consolidation this person is due for under the current policy."""
    limits = _memory_limits()
    work = DueWork()
    turns = len(journal["turns"])
    idle_s = now - float(journal.get("last_turn_at") or now)
    buffer_full = turns >= int(limits["journal_max_turns"]) - 2
    if turns >= int(memory_policy["digest_min_turns"]) or buffer_full:
        work.compact = True
        work.reasons.append("turns")
    elif turns >= 2 and idle_s >= int(limits["idle_compact_minutes"]) * 60:
        work.compact = True
        work.reasons.append("idle")
    elif force and turns:
        work.compact = True
        work.reasons.append("requested")

    new_digests = int(journal.get("digests_since_summary") or 0) + (1 if work.compact else 0)
    new_facts = int(journal.get("facts_since_summary") or 0)
    if new_digests >= int(memory_policy["summary_min_new_digests"]):
        work.summarize = True
        work.reasons.append("digests")
    elif new_facts >= int(memory_policy["summary_min_new_facts"]):
        work.summarize = True
        work.reasons.append("facts")
    elif (force or journal.get("summary_requested")) and (new_digests or new_facts or journal["digests"]):
        work.summarize = True
        work.reasons.append("requested")

    if not work.any:
        return work
    cooldown_s = float(memory_policy["user_cooldown_hours"]) * 3600
    cooling = now - float(journal.get("last_ai_at") or 0) < cooldown_s
    if cooling and not (force or buffer_full):
        return DueWork(reasons=["cooldown"])
    return work


def ai_budget_left(journal: Dict[str, Any], memory_policy: Dict[str, Any], *, now: float) -> int:
    calls = journal.get("ai_calls") or {}
    used = int(calls.get("count") or 0) if calls.get("day") == _today(now) else 0
    return max(0, int(memory_policy["daily_ai_calls_per_user"]) - used)


@dataclass
class ConsolidationReport:
    user_id_hash: str
    level: str
    compacted: bool = False
    summarized: bool = False
    ai_calls: int = 0
    skipped: str = ""

    def as_dict(self) -> Dict[str, Any]:
        return dict(self.__dict__)


class MemoryConsolidationService:
    def __init__(
        self,
        store: Any,
        *,
        memory: Optional[MemoryGraphService] = None,
        generate_json: Optional[GenerateJson] = None,
        load: Optional[Callable[[], LoadState]] = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.store = store
        self.memory = memory or MemoryGraphService(store)
        self._generate_json = generate_json
        self._load = load or current_load
        self._clock = clock

    # -- collect ------------------------------------------------------------

    def record_turn(self, user_id_hash: str, user_text: str, reply_text: str, *, new_facts: int = 0) -> bool:
        """Journal one normal chat turn. Returns True when consolidation is due."""
        if not user_id_hash or not user_text.strip() or crisis_evidence(user_text):
            return False
        limits = _memory_limits()
        now = self._clock()
        memory_policy = self._load().policy("memory")
        due = {"value": False}

        def mutate(current: Any, write: Any) -> None:
            journal = _journal(current, user_id_hash)
            journal["turns"].append(
                {
                    "at": now,
                    "user": _clip(user_text, int(limits["journal_turn_chars"])),
                    "reply": _clip(reply_text, int(limits["reply_chars"])),
                }
            )
            journal["turns"] = journal["turns"][-int(limits["journal_max_turns"]) :]
            journal["facts_since_summary"] = int(journal["facts_since_summary"]) + max(0, int(new_facts))
            journal["last_turn_at"] = now
            due["value"] = due_work(journal, memory_policy, now=now).any
            write(journal)

        try:
            self.store.transact(JOURNAL_COLLECTION, user_id_hash, mutate)
            if due["value"]:
                self.enqueue(user_id_hash, reason="threshold")
        except Exception as exc:
            logger.warning("memory_journal_write_skipped error=%s", type(exc).__name__)
            return False
        return due["value"]

    def add_digest(self, user_id_hash: str, text: str, *, source: str = "voice") -> None:
        """A summary produced elsewhere (a voice call recap) becomes a digest for free."""
        clean = _clip(text, 600)
        if not user_id_hash or not clean or crisis_evidence(clean):
            return
        now = self._clock()

        vector = self._digest_vector(clean)

        def mutate(current: Any, write: Any) -> None:
            journal = _journal(current, user_id_hash)
            journal["digests"] = self._append_digest(journal["digests"], {"text": clean, "source": source, **vector}, now)
            journal["digests_since_summary"] = int(journal["digests_since_summary"]) + 1
            write(journal)

        try:
            self.store.transact(JOURNAL_COLLECTION, user_id_hash, mutate)
            self.enqueue(user_id_hash, reason=f"{source}_digest")
        except Exception as exc:
            logger.warning("memory_digest_add_skipped error=%s", type(exc).__name__)

    def enqueue(self, user_id_hash: str, *, reason: str) -> None:
        existing = self.store.get_document(JOBS_COLLECTION, user_id_hash) or {}
        self.store.set_document(
            JOBS_COLLECTION,
            user_id_hash,
            {
                "user_id_hash": user_id_hash,
                "reason": reason[:40],
                "requested_at": float(existing.get("requested_at") or self._clock()),
                # New on every request: a run only removes the job it started with.
                "generation": uuid.uuid4().hex,
            },
        )

    def request_summary(self, user_id_hash: str) -> None:
        """The person asked for a fresh summary (memory inspector refresh)."""

        def mutate(current: Any, write: Any) -> None:
            journal = _journal(current, user_id_hash)
            journal["summary_requested"] = True
            write(journal)

        self.store.transact(JOURNAL_COLLECTION, user_id_hash, mutate)
        self.enqueue(user_id_hash, reason="requested")

    def has_pending(self, user_id_hash: str) -> bool:
        return bool(user_id_hash) and self.store.get_document(JOBS_COLLECTION, user_id_hash) is not None

    # -- run ----------------------------------------------------------------

    def run(self, user_id_hash: str, *, force: bool = False, allow_deferred: bool = False) -> ConsolidationReport:
        load = self._load()
        report = ConsolidationReport(user_id_hash=user_id_hash, level=load.level)
        memory_policy = load.policy("memory")
        now = self._clock()
        generation = (self.store.get_document(JOBS_COLLECTION, user_id_hash) or {}).get("generation")
        journal = _journal(self.store.get_document(JOURNAL_COLLECTION, user_id_hash), user_id_hash)
        requested = bool(journal.get("summary_requested"))
        work = due_work(journal, memory_policy, now=now, force=force or requested)
        if not work.any:
            report.skipped = work.reasons[0] if work.reasons else "not_due"
            self._finish_job(user_id_hash, keep=report.skipped == "cooldown", generation=generation)
            return report
        if load.level == "critical" and not allow_deferred and not requested:
            report.skipped = "load_critical"
            return report
        lease = self._acquire(user_id_hash, memory_policy, now=now)
        if lease is None:
            report.skipped = "in_progress"
            return report
        token, budget = lease
        if budget <= 0:
            self._release(user_id_hash, token, reserved=0, used=0)
            report.skipped = "daily_budget"
            return report
        try:
            self._started_at = time.time()
            return self._run_leased(user_id_hash, report, work, journal, memory_policy, budget, generation, load)
        finally:
            self._release(user_id_hash, token, reserved=budget, used=report.ai_calls)

    def _run_leased(
        self,
        user_id_hash: str,
        report: "ConsolidationReport",
        work: DueWork,
        journal: Dict[str, Any],
        memory_policy: Dict[str, Any],
        budget: int,
        generation: Any,
        load: LoadState,
    ) -> "ConsolidationReport":

        if work.compact and budget > 0:
            if self._compact(user_id_hash, journal):
                report.compacted = True
                report.ai_calls += 1
                budget -= 1
                journal = _journal(self.store.get_document(JOURNAL_COLLECTION, user_id_hash), user_id_hash)
        # A person with digests but no summary yet gets their first one in the same
        # run, instead of waiting a cooldown for a second digest.
        if report.compacted and not work.summarize and not self.memory.get_memory_graph(user_id_hash).narrative:
            work.summarize = True
            work.reasons.append("first_summary")
        if work.summarize and budget > 0:
            if self._summarize(user_id_hash, journal):
                report.summarized = True
                report.ai_calls += 1
        remaining = due_work(
            _journal(self.store.get_document(JOURNAL_COLLECTION, user_id_hash), user_id_hash), memory_policy, now=self._clock()
        )
        # Keep the job while work remains (including a failed AI call, retried by the scheduler).
        self._finish_job(user_id_hash, keep=remaining.any, generation=generation)
        logger.info(
            "memory_consolidation user_present=1 level=%s compacted=%s summarized=%s ai_calls=%s reasons=%s",
            load.level, report.compacted, report.summarized, report.ai_calls, ",".join(work.reasons),
        )
        return report

    def run_due(self, *, limit: Optional[int] = None) -> Dict[str, Any]:
        """Scheduler entry point: process queued jobs within the load policy."""
        load = self._load()
        memory_policy = load.policy("memory")
        batch = int(memory_policy["cron_batch"]) if limit is None else int(limit)
        max_defer_s = float(memory_policy["max_defer_hours"]) * 3600
        now = self._clock()
        jobs = sorted(
            (doc for _doc_id, doc in self.store.iter_documents(JOBS_COLLECTION)),
            key=lambda job: float(job.get("requested_at") or now),
        )
        reports: List[Dict[str, Any]] = []
        deadline = time.monotonic() + CRON_TIME_BUDGET_S
        for job in jobs:
            if time.monotonic() >= deadline:
                logger.info("memory_consolidation_batch_time_budget_reached processed=%s", len(reports))
                break
            if float(job.get("not_before") or 0) > now:
                continue  # backing off after failures
            overdue = now - float(job.get("requested_at") or now) >= max_defer_s
            if len(reports) >= batch and not overdue:
                continue
            if len(reports) >= max(batch, 5) and overdue:
                break
            user = str(job.get("user_id_hash") or "")
            if not user:
                continue
            try:
                report = self.run(user, allow_deferred=overdue)
                reports.append(report.as_dict())
                if not report.ai_calls and not report.skipped:
                    self._back_off(user, job, now)  # work was due but every model call failed
            except Exception as exc:
                logger.warning("memory_consolidation_failed error=%s", type(exc).__name__)
                self._back_off(user, job, now)
        return {"level": load.level, "queued": len(jobs), "processed": len(reports), "reports": reports}

    # -- AI steps -----------------------------------------------------------

    def _generate(self, **kwargs: Any) -> str:
        if self._generate_json is not None:
            return self._generate_json(**kwargs)
        from backend.infra.llm.gateway import get_llm_gateway

        return get_llm_gateway().generate_json(**kwargs)

    def _compact(self, user_id_hash: str, journal: Dict[str, Any]) -> bool:
        limits = _memory_limits()
        turns = [t for t in journal["turns"] if not crisis_evidence(str(t.get("user") or ""))]
        if not turns:
            return False
        lines: List[str] = []
        budget = int(limits["digest_input_chars"])
        for turn in reversed(turns):
            line = f"Person: {turn.get('user', '')}\nCompanion: {turn.get('reply', '')}"
            if len(line) > budget:
                break
            lines.insert(0, line)
            budget -= len(line)
        try:
            raw = self._generate(
                prompt="Conversation turns, oldest first:\n\n" + "\n\n".join(lines),
                system_instruction=DIGEST_SYSTEM.replace("{words}", str(limits["digest_max_words"])),
                temperature=0.2,
                max_tokens=320,
            )
            output = parse_provider_output(MemoryDigestOutput, raw)
        except Exception as exc:
            logger.warning("memory_digest_failed error=%s", type(exc).__name__)
            return False
        if self._fenced(user_id_hash):
            return False
        digest_text = _clip(output.digest, 600)
        if crisis_evidence(digest_text):
            digest_text = "They went through a very hard moment and talked it through."
        self._merge_ai_facts(user_id_hash, output.facts)
        vector = self._digest_vector(digest_text)
        compacted_upto = float(turns[-1].get("at") or 0)
        now = self._clock()

        def mutate(current: Any, write: Any) -> None:
            fresh = _journal(current, user_id_hash)
            entry = {"text": digest_text, "themes": output.themes, "helped": output.helped, "source": "chat", **vector}
            fresh["digests"] = self._append_digest(fresh["digests"], entry, now)
            # Data minimization: the raw turns this digest covers are deleted.
            fresh["turns"] = [t for t in fresh["turns"] if float(t.get("at") or 0) > compacted_upto]
            fresh["digests_since_summary"] = int(fresh["digests_since_summary"]) + 1
            write(fresh)

        self.store.transact(JOURNAL_COLLECTION, user_id_hash, mutate)
        return True

    def _summarize(self, user_id_hash: str, journal: Dict[str, Any]) -> bool:
        limits = _memory_limits()
        graph = self.memory.get_memory_graph(user_id_hash)
        facts = [f"- {atom.value}" for atom in rank_atoms(graph.atoms)[:12]]
        digests = [f"- ({time.strftime('%Y-%m-%d', time.gmtime(float(d.get('at') or 0)))}) {d.get('text', '')}" for d in journal["digests"][-8:]]
        if not facts and not digests:
            return False
        prompt = (
            f"Today: {time.strftime('%Y-%m-%d (%A)', time.gmtime(self._clock()))}\n\n"
            f"Previous summary:\n{graph.narrative or '(none yet)'}\n\n"
            f"Saved facts (most important first):\n{chr(10).join(facts) or '(none)'}\n\n"
            f"Recent conversation digests (oldest first):\n{chr(10).join(digests) or '(none)'}"
        )
        try:
            raw = self._generate(
                prompt=prompt,
                system_instruction=SUMMARY_SYSTEM.replace("{words}", str(limits["summary_max_words"])),
                temperature=0.2,
                max_tokens=400,
            )
            output = parse_provider_output(MemorySummaryOutput, raw)
        except Exception as exc:
            logger.warning("memory_summary_failed error=%s", type(exc).__name__)
            return False
        if self._fenced(user_id_hash):
            return False
        narrative = _clip(output.summary, int(limits["summary_max_chars"]))
        if crisis_evidence(narrative):
            logger.warning("memory_summary_rejected reason=crisis_content")
            return False
        graph = self.memory.get_memory_graph(user_id_hash)
        graph.narrative = narrative
        graph.narrative_at = self._clock()
        graph.open_threads = [thread for thread in output.open_threads if not crisis_evidence(thread)][:3]
        graph.thread_after = {q: d for q, d in output.thread_after.items() if q in graph.open_threads}
        self.memory.save_memory_graph(graph)

        def mutate(current: Any, write: Any) -> None:
            fresh = _journal(current, user_id_hash)
            fresh["digests_since_summary"] = 0
            fresh["facts_since_summary"] = 0
            fresh["summary_requested"] = False
            fresh["last_summary_at"] = self._clock()
            write(fresh)

        self.store.transact(JOURNAL_COLLECTION, user_id_hash, mutate)
        return True

    def _digest_vector(self, text: str) -> Dict[str, Any]:
        """A vector for search by meaning, when load and configuration allow. Best effort."""
        try:
            if not self._load().policy("retrieval")["semantic"]:
                return {}
            from backend.infra.llm.embeddings import compact, get_embedder

            embedder = get_embedder()
            vectors = embedder.embed([text], task="RETRIEVAL_DOCUMENT") if embedder else None
            return {"vec": compact(vectors[0])} if vectors else {}
        except Exception as exc:
            logger.warning("memory_digest_vector_skipped error=%s", type(exc).__name__)
            return {}

    def _merge_ai_facts(self, user_id_hash: str, facts: List[Dict[str, str]]) -> int:
        """Facts found by the digest call, merged at lower confidence than explicit ones.

        This is where non-English facts come from: the pattern extractor is
        English-first, the model is not. Crisis content and contact details are
        never stored.
        """
        atoms: List[MemoryAtom] = []
        for fact in facts[:5]:
            value = _clip(str(fact.get("value") or ""), 90)
            category = str(fact.get("category") or "facts").strip().lower()[:24] or "facts"
            if not value or crisis_evidence(value) or _CONTACT.search(value):
                continue
            atom_id = f"{category}:ai:{_slug(value)}"
            atoms.append(MemoryAtom(id=atom_id, category=category, value=value, confidence=0.7))
        if not atoms:
            return 0
        try:
            _graph, saved = self.memory.merge_atoms(user_id_hash, atoms)
        except Exception as exc:
            logger.warning("memory_ai_facts_skipped error=%s", type(exc).__name__)
            return 0
        return len(saved)

    # -- bookkeeping --------------------------------------------------------

    def _append_digest(self, digests: List[Dict[str, Any]], entry: Dict[str, Any], now: float) -> List[Dict[str, Any]]:
        digests = list(digests) + [{"id": uuid.uuid4().hex[:10], "at": now, **entry}]
        return digests[-int(_memory_limits()["max_digests"]) :]

    def _back_off(self, user_id_hash: str, job: Dict[str, Any], now: float) -> None:
        """Push a failing job back so the rest of the queue gets its turn."""
        generation = job.get("generation")

        def mutate(current: Any, write: Any) -> None:
            if not current or current.get("generation") != generation:
                return  # finished or re-queued meanwhile: leave it alone
            attempts = int(current.get("attempts") or 0) + 1
            delay = min(RETRY_MAX_S, RETRY_BASE_S * (2 ** (attempts - 1)))
            write({**current, "attempts": attempts, "not_before": now + delay})

        try:
            self.store.transact(JOBS_COLLECTION, user_id_hash, mutate)
        except Exception as exc:
            logger.warning("memory_consolidation_backoff_failed error=%s", type(exc).__name__)

    def _fenced(self, user_id_hash: str) -> bool:
        """The account's data was deleted while this run waited on the model (audit MP-06)."""
        started = getattr(self, "_started_at", None)
        if started is None or not deleted_since(self.store, user_id_hash, started):
            return False
        logger.info("memory_consolidation_fenced reason=account_data_deleted")
        return True

    def _acquire(self, user_id_hash: str, memory_policy: Dict[str, Any], *, now: float) -> Optional[tuple[str, int]]:
        """Take this person's run lease and reserve its model calls, or None if another run holds it."""
        token = uuid.uuid4().hex

        def mutate(current: Any, write: Any) -> Optional[int]:
            journal = _journal(current, user_id_hash)
            lease = journal.get("lease")
            if isinstance(lease, dict) and float(lease.get("until") or 0) > now:
                return None
            budget = min(ai_budget_left(journal, memory_policy, now=now), MAX_AI_CALLS_PER_RUN)
            if budget > 0:
                day = _today(now)
                used = int(journal["ai_calls"].get("count") or 0) if journal["ai_calls"].get("day") == day else 0
                journal["ai_calls"] = {"day": day, "count": used + budget}
            journal["lease"] = {"token": token, "until": now + RUN_LEASE_SECONDS}
            write(journal)
            return budget

        budget = self.store.transact(JOURNAL_COLLECTION, user_id_hash, mutate)
        return None if budget is None else (token, int(budget))

    def _release(self, user_id_hash: str, token: str, *, reserved: int, used: int) -> None:
        """Give back reserved calls that were not made, and drop the lease if still ours."""
        now = self._clock()

        def mutate(current: Any, write: Any) -> None:
            if current is None:
                return  # deleted meanwhile: nothing to release, and nothing to recreate
            journal = _journal(current, user_id_hash)
            lease = journal.get("lease")
            if isinstance(lease, dict) and lease.get("token") == token:
                journal["lease"] = None
            unused = max(0, reserved - used)
            if unused and journal["ai_calls"].get("day") == _today(now):
                journal["ai_calls"] = {
                    "day": journal["ai_calls"]["day"],
                    "count": max(0, int(journal["ai_calls"].get("count") or 0) - unused),
                }
            if used:
                journal["last_ai_at"] = now
            write(journal)

        try:
            self.store.transact(JOURNAL_COLLECTION, user_id_hash, mutate)
        except Exception as exc:  # the lease expires on its own; unused calls stay charged
            logger.warning("memory_consolidation_release_failed error=%s", type(exc).__name__)

    def _finish_job(self, user_id_hash: str, *, keep: bool, generation: Any = None) -> None:
        if keep:
            return
        # A request that arrived while this run worked has a new generation and
        # its own work to do: it stays queued.
        current = self.store.get_document(JOBS_COLLECTION, user_id_hash)
        if current and generation is not None and current.get("generation") != generation:
            return
        self.store.delete_document(JOBS_COLLECTION, user_id_hash)

    # -- person-facing ------------------------------------------------------

    def describe(self, user_id_hash: str) -> Dict[str, Any]:
        journal = _journal(self.store.get_document(JOURNAL_COLLECTION, user_id_hash), user_id_hash)
        graph = self.memory.get_memory_graph(user_id_hash)
        return {
            "narrative": graph.narrative,
            "narrative_at": graph.narrative_at,
            "open_threads": graph.open_threads,
            "digests": [
                {"at": d.get("at"), "text": d.get("text"), "themes": d.get("themes") or [], "source": d.get("source")}
                for d in journal["digests"]
            ],
            "pending_turns": len(journal["turns"]),
            "queued": self.has_pending(user_id_hash),
        }

    def forget_facts(self, user_id_hash: str, values: List[str]) -> None:
        """The person deleted facts: nothing AI-written may keep repeating them.

        The AI summary is dropped (it may paraphrase the fact), digests that
        mention a deleted fact are removed, and a fresh summary is queued from
        what remains.
        """
        needles = [needle for value in values for needle in _fact_needles(value)]

        def drop_narrative(graph: Any) -> Any:
            if not graph.narrative:
                return NO_WRITE
            graph.narrative, graph.narrative_at, graph.open_threads = "", 0.0, []
            return None

        self.memory.mutate_graph(user_id_hash, drop_narrative)

        def mutate(current: Any, write: Any) -> None:
            journal = _journal(current, user_id_hash)
            journal["digests"] = [
                d for d in journal["digests"] if not any(n in str(d.get("text") or "").lower() for n in needles)
            ]
            journal["turns"] = [
                t for t in journal["turns"] if not any(n in str(t.get("user") or "").lower() for n in needles)
            ]
            journal["summary_requested"] = bool(journal["digests"])
            write(journal)

        try:
            self.store.transact(JOURNAL_COLLECTION, user_id_hash, mutate)
            self.enqueue(user_id_hash, reason="facts_deleted")
        except Exception as exc:
            logger.warning("memory_forget_facts_partial error=%s", type(exc).__name__)

    def forget(self, user_id_hash: str) -> None:
        """Delete the AI summary, digests, and journal (facts are managed separately)."""
        def drop_narrative(graph: Any) -> None:
            graph.narrative, graph.narrative_at, graph.open_threads = "", 0.0, []

        self.memory.mutate_graph(user_id_hash, drop_narrative)
        self.store.delete_document(JOURNAL_COLLECTION, user_id_hash)
        self.store.delete_document(JOBS_COLLECTION, user_id_hash)
