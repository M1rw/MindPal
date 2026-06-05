# backend/services/memory_service.py

from __future__ import annotations

import json
import os
import re
from dataclasses import asdict, dataclass
from typing import Any

from pydantic import ValidationError as PydanticValidationError

from backend.core.config import Settings, get_settings
from backend.core.errors import MemoryServiceError
from backend.core.security import (
    redact_basic_pii,
    safe_truncate,
    sanitize_text,
)
from backend.models.memory import (
    CommunicationPreferences,
    ImportantPerson,
    MemoryCategory,
    MemoryCompactionRequest,
    MemoryCompactionResult,
    MemoryInteraction,
    MemoryInteractionRole,
    MemoryItem,
    MemorySensitivity,
    MemorySource,
    MemorySummary,
    RelationshipFact,
)
from backend.services.llm_service import LLMService, build_llm_request


MAX_COMPACTED_SUMMARY_CHARS = 4_000
MAX_EXTRACTED_ITEM_TEXT_CHARS = 500
MAX_ITEMS_PER_COMPACTION = 20
MAX_LIST_FIELD_ITEMS = 80
MIN_INTERACTIONS_FOR_AUTO_COMPACTION = 4
MAX_LLM_INTERACTION_CHARS = 1_200
MAX_LLM_INTERACTIONS = 24
MAX_LLM_JSON_CHARS = 12_000

_EMAIL_OR_PHONE_PLACEHOLDER_RE = re.compile(
    r"\[(?:redacted_email|redacted_phone|redacted_secret)\]",
    re.IGNORECASE,
)
_MEMORY_EMAIL_RE = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.IGNORECASE)
_MEMORY_PHONE_RE = re.compile(r"(?<!\w)(?:\+?\d[\d\s().-]{7,}\d)(?!\w)")
_MEMORY_BEARER_RE = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}")
_MEMORY_KEY_VALUE_SECRET_RE = re.compile(
    r"(?i)\b(api[_-]?key|token|access[_-]?token|refresh[_-]?token|secret|password)"
    r"\s*[:=]\s*"
    r"(['\"]?)[A-Za-z0-9._~+/=-]{8,}\2"
)
_MEMORY_LONG_TOKEN_RE = re.compile(
    r"\b(?=[A-Za-z0-9._~+/=-]*[A-Za-z])(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{20,}\b"
)

_TRIGGER_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("exams", re.compile(r"(?i)\bexam|quiz|midterm|final|امتحان|كويز\b")),
    ("panic", re.compile(r"(?i)\bpanic|panic attack|نوبة هلع|نوبة فزع\b")),
    ("anxiety", re.compile(r"(?i)\banxious|anxiety|قلقان|قلقانة|توتر\b")),
    ("sleep", re.compile(r"(?i)\bsleep|insomnia|night|مش عارف انام|نوم\b")),
    ("relationship", re.compile(r"(?i)\bgirlfriend|boyfriend|partner|relationship|صاحبتي|حبيبتي|حبيبي\b")),
    ("anger", re.compile(r"(?i)\bangry|rage|furious|غضب|متنرفز|عصبي\b")),
    ("loneliness", re.compile(r"(?i)\balone|lonely|no one cares|لوحدي|وحيد|محدش\b")),
)

_COPING_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("box breathing", re.compile(r"(?i)\bbox breathing|تنفس مربع\b")),
    ("5-4-3-2-1 grounding", re.compile(r"(?i)\b5-4-3-2-1|54321|grounding|تأريض\b")),
    ("journaling", re.compile(r"(?i)\bjournal|journaling|write it down|اكتب\b")),
    ("walking", re.compile(r"(?i)\bwalk|walking|تمشية|امشي\b")),
    ("calling someone trusted", re.compile(r"(?i)\bcall someone|trusted person|كلم حد|اتصل بحد\b")),
)

_GOAL_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"(?i)\bI\s+(?:want|need|am trying)\s+to\s+(.{3,140})"),
    re.compile(r"(?i)\bmy\s+goal\s+is\s+(.{3,140})"),
    re.compile(r"(?i)(?:عايز|عاوز|محتاج|نفسي)\s+(.{3,140})"),
)

_PREFERENCE_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"(?i)\bI\s+prefer\s+(.{3,140})"),
    re.compile(r"(?i)\bI\s+like\s+when\s+(.{3,140})"),
    re.compile(r"(?i)\bplease\s+(?:be|keep|make)\s+(.{3,140})"),
    re.compile(r"(?i)(?:بفضل|افضل|أفضل|عايزك)\s+(.{3,140})"),
)

_PREFERRED_NAME_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"(?i)\b(?:my name is|call me|i am called|i'm called)\s+([A-Za-z\u0600-\u06FF][^.,!?\n]{0,60})"),
    re.compile(r"(?i)\b(?:remember(?: this)?[:\s]+)?(?:my preferred name is)\s+([A-Za-z\u0600-\u06FF][^.,!?\n]{0,60})"),
    re.compile(r"(?:اسمي|ناديني|ناديني باسم|اسمي هو)\s+([\u0600-\u06FFA-Za-z][^.,!?\n،؟]{0,60})"),
)

_IMPORTANT_PERSON_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("girlfriend", re.compile(r"(?i)\bmy girlfriend\s+(?:is\s+)?(?:called|named|is)\s+([^.,\n]{2,80})")),
    ("boyfriend", re.compile(r"(?i)\bmy boyfriend\s+(?:is\s+)?(?:called|named|is)\s+([^.,\n]{2,80})")),
    ("partner", re.compile(r"(?i)\bmy partner\s+(?:is\s+)?(?:called|named|is)\s+([^.,\n]{2,80})")),
    ("girlfriend", re.compile(r"(?:حبيبتي|صاحبتي)\s+(?:اسمها|هي|اسمها هو)\s+([^\n.,،]{2,80})")),
    ("boyfriend", re.compile(r"(?:حبيبي|صاحبي)\s+(?:اسمه|هو|اسمه هو)\s+([^\n.,،]{2,80})")),
)

_ALIAS_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"(?i)\b(?:i may write|may write|also call|or call)\s+(?:her|his|him|their|them|that person)?\s*(?:name)?\s*(?:as|:)?\s+(.{2,120})$"),
    re.compile(r"(?i)\b(?:also known as|aka)\s+(.{2,120})$"),
    re.compile(r"^(?:or|او|أو)\s+(.{2,80})$", re.IGNORECASE),
)

_DIRECT_STYLE_RE = re.compile(r"(?i)\b(?:direct answers|be direct|straight to the point|no fluff|brief|concise)\b")
_EGYPTIAN_ARABIC_RE = re.compile(r"(?i)\b(?:egyptian arabic|egyptian dialect|masri)\b|(?:مصري|بالعامية|عامية مصرية)")
_AVOID_RESPONSE_RE = re.compile(r"(?i)\b(?:don't|do not|avoid|stop)\s+(?:answering\s+)?(?:like\s+)?(.{3,140})")

_SAFETY_FLAG_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("recent self-harm-related distress", re.compile(r"(?i)\bkill myself|suicide|end my life|hurt myself|هنتحر|هقتل نفسي\b")),
    ("possible immediate danger", re.compile(r"(?i)\bnot safe|danger|threatened|مش آمن|خطر|بيهددني\b")),
    ("severe emotional distress", re.compile(r"(?i)\bcan't take this|hopeless|worthless|مش قادر اكمل|يائس\b")),
)

MEMORY_SYSTEM_PROMPT = """
You are MindPal's memory compaction engine.

Your job is to convert sanitized conversation fragments into compact, privacy-safe support memory.

Critical rules:
- Return JSON only.
- Do not include raw chat logs.
- Do not include emails, phone numbers, street addresses, tokens, secrets, or exact sensitive identifiers.
- Do not diagnose the user.
- Do not infer medical conditions.
- Do not create therapy claims.
- Do not store unnecessary intimate detail.
- Store only durable support context useful for future wellness conversations.
- Keep everything short, factual, non-clinical, and user-controllable.

Return exactly this JSON shape:
{
  "preferred_name": "short name or null",
  "important_people": [
    {
      "canonical_name": "short name",
      "aliases": ["alias"],
      "relationship": "girlfriend|boyfriend|partner|friend|family|other",
      "notes": ["short durable note"],
      "confidence": 0.0
    }
  ],
  "relationship_facts": [
    {
      "summary": "short durable relationship fact",
      "people": ["name"],
      "confidence": 0.0
    }
  ],
  "communication_preferences": {
    "tone": "short tone",
    "language": "short language preference",
    "response_style": ["short preference"],
    "avoid": ["short avoided response"]
  },
  "emotional_triggers": ["short trigger"],
  "user_goals": ["short goal"],
  "avoided_responses": ["short avoided response"],
  "summary": "short sanitized summary",
  "known_triggers": ["short trigger"],
  "preferred_coping_tools": ["short coping tool"],
  "goals": ["short wellness goal"],
  "preferences": ["short communication/support preference"],
  "safety_flags": ["short safety flag"],
  "items": [
    {
      "category": "trigger|coping_tool|goal|preference|safety_flag|life_event|support_context|other",
      "text": "short sanitized memory item",
      "sensitivity": "low|medium|high",
      "confidence": 0.0
    }
  ]
}
""".strip()


@dataclass(frozen=True, slots=True)
class MemoryExtraction:
    summary_sentences: tuple[str, ...]
    preferred_name: str | None
    important_people: tuple[ImportantPerson, ...]
    relationship_facts: tuple[RelationshipFact, ...]
    communication_preferences: CommunicationPreferences
    emotional_triggers: tuple[str, ...]
    user_goals: tuple[str, ...]
    avoided_responses: tuple[str, ...]
    triggers: tuple[str, ...]
    coping_tools: tuple[str, ...]
    goals: tuple[str, ...]
    preferences: tuple[str, ...]
    safety_flags: tuple[str, ...]
    items: tuple[MemoryItem, ...]


@dataclass(frozen=True, slots=True)
class MemoryCompactionMeta:
    mode: str
    used_llm: bool
    fallback_used: bool
    provider_used: str | None = None
    error_code: str | None = None


@dataclass(frozen=True, slots=True)
class LLMCompactionOutcome:
    result: MemoryCompactionResult
    provider_used: str


class MemoryService:
    """
    Privacy-first memory compaction service.

    Primary path:
    - sanitize/redact bounded interaction fragments
    - ask LLM to produce strict JSON memory summary
    - validate through Pydantic models
    - merge deterministic local extraction so safety/context signals are not missed

    Fallback path:
    - deterministic local extraction only

    This service does not persist anything. db_service handles storage.
    """

    def __init__(
        self,
        *,
        settings: Settings | None = None,
        llm_service: LLMService | None = None,
        enable_llm_summarization: bool | None = None,
        allow_offline_llm_summarization: bool | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.production_mode = _is_production(self.settings)
        self.llm_service = llm_service

        self.enable_llm_summarization = (
            _setting_bool(
                self.settings,
                "ENABLE_LLM_MEMORY_SUMMARIZATION",
                default=True,
            )
            if enable_llm_summarization is None
            else bool(enable_llm_summarization)
        )

        self.allow_offline_llm_summarization = (
            _setting_bool(
                self.settings,
                "ALLOW_OFFLINE_LLM_MEMORY_SUMMARIZATION",
                default=False,
            )
            if allow_offline_llm_summarization is None
            else bool(allow_offline_llm_summarization)
        )

        self.summary_max_chars = int(self.settings.MEMORY_SUMMARY_MAX_CHARS)
        self.last_meta: MemoryCompactionMeta | None = None

    async def compact(self, request: MemoryCompactionRequest) -> MemoryCompactionResult:
        existing = request.existing_summary or MemorySummary(user_id_hash=request.user_id_hash)

        if not request.force and not self.should_compact(request.interactions):
            self.last_meta = MemoryCompactionMeta(
                mode="skipped",
                used_llm=False,
                fallback_used=False,
            )
            return MemoryCompactionResult(
                request_id=request.request_id,
                user_id_hash=request.user_id_hash,
                summary=existing,
                changed=False,
                items_added=0,
            )

        provider_state = self._summarization_provider_state()

        if (
            self.enable_llm_summarization
            and self.llm_service is not None
            and provider_state["summarization_can_call_llm"]
        ):
            try:
                outcome = await self._compact_with_llm(request, existing)
                self.last_meta = MemoryCompactionMeta(
                    mode="llm_primary",
                    used_llm=True,
                    fallback_used=False,
                    provider_used=outcome.provider_used,
                )
                return outcome.result
            except Exception as exc:
                self.last_meta = MemoryCompactionMeta(
                    mode="local_fallback",
                    used_llm=True,
                    fallback_used=True,
                    error_code=exc.__class__.__name__,
                )
                return self.compact_local(request)

        if self.enable_llm_summarization and self.llm_service is not None:
            self.last_meta = MemoryCompactionMeta(
                mode="local_fallback",
                used_llm=False,
                fallback_used=True,
                error_code="memory_llm_provider_unavailable",
            )
            return self.compact_local(request)

        self.last_meta = MemoryCompactionMeta(
            mode="local_only",
            used_llm=False,
            fallback_used=True,
            error_code="llm_service_missing_or_disabled",
        )
        return self.compact_local(request)

    def compact_local(self, request: MemoryCompactionRequest) -> MemoryCompactionResult:
        existing = request.existing_summary or MemorySummary(user_id_hash=request.user_id_hash)

        if not request.force and not self.should_compact(request.interactions):
            return MemoryCompactionResult(
                request_id=request.request_id,
                user_id_hash=request.user_id_hash,
                summary=existing,
                changed=False,
                items_added=0,
            )

        extraction = self.extract_from_interactions(request.interactions)
        merged = self.merge_summary(existing, extraction, user_id_hash=request.user_id_hash)

        return MemoryCompactionResult(
            request_id=request.request_id,
            user_id_hash=request.user_id_hash,
            summary=merged,
            changed=_summary_changed(existing, merged),
            items_added=len(extraction.items),
        )

    def redact_text(self, text: str, *, max_chars: int = MAX_COMPACTED_SUMMARY_CHARS) -> str:
        cleaned = sanitize_text(text, max_chars)
        cleaned = _redact_memory_sensitive(cleaned)
        return safe_truncate(cleaned, max_chars)

    def should_compact(self, interactions: list[MemoryInteraction]) -> bool:
        if len(interactions) >= MIN_INTERACTIONS_FOR_AUTO_COMPACTION:
            return True

        joined = "\n".join(interaction.content for interaction in interactions)
        extraction = self.extract(joined)
        return bool(
            extraction.triggers
            or extraction.coping_tools
            or extraction.goals
            or extraction.preferences
            or extraction.safety_flags
        )

    def extract_from_interactions(self, interactions: list[MemoryInteraction]) -> MemoryExtraction:
        user_text = "\n".join(
            interaction.content
            for interaction in interactions
            if interaction.role == MemoryInteractionRole.USER
        )

        # Strip any injected instruction prefixes from user text
        user_text = _strip_instruction_prefixes(user_text)

        assistant_text = "\n".join(
            interaction.content
            for interaction in interactions
            if interaction.role == MemoryInteractionRole.ASSISTANT
        )

        return self.extract(
            "\n".join(part for part in (user_text, assistant_text) if part.strip())
        )

    def extract(self, text: str) -> MemoryExtraction:
        cleaned = self.redact_text(text, max_chars=MAX_COMPACTED_SUMMARY_CHARS)

        if not cleaned:
            return MemoryExtraction((), None, (), (), CommunicationPreferences(), (), (), (), (), (), (), (), (), ())

        preferred_name = self._extract_preferred_name(cleaned)
        important_people = self._extract_important_people(cleaned)
        relationship_facts = self._extract_relationship_facts(cleaned, important_people)
        communication_preferences = self._extract_communication_preferences(cleaned)
        avoided_responses = self._extract_avoided_responses(cleaned)
        triggers = self._extract_named_patterns(cleaned, _TRIGGER_PATTERNS)
        coping_tools = self._extract_named_patterns(cleaned, _COPING_PATTERNS)
        goals = self._extract_capture_patterns(cleaned, _GOAL_PATTERNS)
        preferences = self._extract_capture_patterns(cleaned, _PREFERENCE_PATTERNS)
        safety_flags = self._extract_named_patterns(cleaned, _SAFETY_FLAG_PATTERNS)
        summary_sentences = self._extract_summary_sentences(cleaned)

        items = self._build_memory_items(
            triggers=triggers,
            coping_tools=coping_tools,
            goals=goals,
            preferences=preferences,
            safety_flags=safety_flags,
        )

        return MemoryExtraction(
            summary_sentences=tuple(summary_sentences),
            preferred_name=preferred_name,
            important_people=tuple(important_people),
            relationship_facts=tuple(relationship_facts),
            communication_preferences=communication_preferences,
            emotional_triggers=tuple(triggers),
            user_goals=tuple(goals),
            avoided_responses=tuple(avoided_responses),
            triggers=tuple(triggers),
            coping_tools=tuple(coping_tools),
            goals=tuple(goals),
            preferences=tuple(preferences),
            safety_flags=tuple(safety_flags),
            items=tuple(items),
        )

    def merge_summary(
        self,
        existing: MemorySummary,
        extraction: MemoryExtraction,
        *,
        user_id_hash: str,
    ) -> MemorySummary:
        return MemorySummary(
            user_id_hash=user_id_hash,
            summary=self._merge_summary_text(existing.summary, extraction.summary_sentences),
            preferred_name=extraction.preferred_name or existing.preferred_name,
            important_people=_merge_important_people(
                existing.important_people,
                list(extraction.important_people),
            ),
            relationship_facts=_merge_relationship_facts(
                existing.relationship_facts,
                list(extraction.relationship_facts),
            ),
            communication_preferences=_merge_communication_preferences(
                existing.communication_preferences,
                extraction.communication_preferences,
            ),
            emotional_triggers=_merge_unique(existing.emotional_triggers, extraction.emotional_triggers),
            user_goals=_merge_unique(existing.user_goals, extraction.user_goals),
            avoided_responses=_merge_unique(existing.avoided_responses, extraction.avoided_responses),
            known_triggers=_merge_unique(existing.known_triggers, extraction.triggers),
            preferred_coping_tools=_merge_unique(
                existing.preferred_coping_tools,
                extraction.coping_tools,
            ),
            goals=_merge_unique(existing.goals, extraction.goals),
            preferences=_merge_unique(existing.preferences, extraction.preferences),
            safety_flags=_merge_unique(existing.safety_flags, extraction.safety_flags),
            items=_merge_memory_items(existing.items, list(extraction.items)),
            last_safety_level=existing.last_safety_level,
            source=MemorySource.CHAT_COMPACTION,
            version=max(1, existing.version + 1),
        )

    def build_prompt_summary(self, summary: MemorySummary | None) -> str:
        if summary is None or summary.is_empty():
            return ""

        parts: list[str] = []

        if summary.summary:
            parts.append(f"Summary: {summary.summary}")

        if summary.preferred_name:
            parts.append(f"Preferred name: {summary.preferred_name}")

        if summary.important_people:
            people = []
            for person in summary.important_people[:8]:
                aliases = [alias for alias in person.aliases if alias != person.canonical_name]
                label = person.canonical_name
                if person.relationship:
                    label = f"{label} ({person.relationship})"
                if aliases:
                    label = f"{label}; aliases: {', '.join(aliases[:6])}"
                people.append(label)
            parts.append(f"Important people: {'; '.join(people)}")

        if summary.relationship_facts:
            parts.append(
                "Relationship facts: "
                + "; ".join(fact.summary for fact in summary.relationship_facts[:8])
            )

        if summary.communication_preferences.tone or summary.communication_preferences.language:
            pref_bits = [
                bit
                for bit in (
                    f"tone={summary.communication_preferences.tone}" if summary.communication_preferences.tone else "",
                    f"language={summary.communication_preferences.language}" if summary.communication_preferences.language else "",
                )
                if bit
            ]
            parts.append(f"Communication preferences: {', '.join(pref_bits)}")

        if summary.communication_preferences.response_style:
            parts.append(
                f"Preferred response style: {', '.join(summary.communication_preferences.response_style[:12])}"
            )

        if summary.communication_preferences.avoid or summary.avoided_responses:
            avoid = _merge_unique(
                summary.communication_preferences.avoid,
                summary.avoided_responses,
            )
            parts.append(f"Avoided responses: {', '.join(avoid[:12])}")

        if summary.emotional_triggers:
            parts.append(f"Emotional triggers: {', '.join(summary.emotional_triggers[:12])}")

        if summary.user_goals:
            parts.append(f"User goals: {', '.join(summary.user_goals[:12])}")

        if summary.known_triggers:
            parts.append(f"Known triggers: {', '.join(summary.known_triggers[:12])}")

        if summary.preferred_coping_tools:
            parts.append(
                f"Preferred coping tools: {', '.join(summary.preferred_coping_tools[:12])}"
            )

        if summary.goals:
            parts.append(f"Wellness goals: {', '.join(summary.goals[:12])}")

        if summary.preferences:
            parts.append(f"Communication preferences: {', '.join(summary.preferences[:12])}")

        if summary.safety_flags:
            parts.append(f"Safety flags: {', '.join(summary.safety_flags[:12])}")

        return self.redact_text(
            "\n".join(parts),
            max_chars=min(self.summary_max_chars, MAX_COMPACTED_SUMMARY_CHARS),
        )

    def health(self) -> dict[str, Any]:
        provider_state = self._summarization_provider_state()

        return {
            "mode": "llm_primary_with_local_fallback_only",
            "production_mode": self.production_mode,
            "summary_max_chars": self.summary_max_chars,
            "stores_raw_chat": False,
            "llm_primary_enabled": self.enable_llm_summarization,
            "llm_service_available": self.llm_service is not None,
            "llm_summarization_provider_state": provider_state,
            "llm_summarization_can_call_llm": provider_state["summarization_can_call_llm"],
            "offline_llm_summarization_allowed": self.allow_offline_llm_summarization,
            "local_fallback_available": True,
            "local_extraction_only_on_llm_failure": True,
            "last_meta": None if self.last_meta is None else asdict(self.last_meta),
        }

    def _summarization_provider_state(self) -> dict[str, bool]:
        if self.llm_service is None:
            return {
                "remote_provider_available": False,
                "offline_available": False,
                "offline_allowed_by_llm_service": False,
                "offline_allowed_for_memory_summarization": self.allow_offline_llm_summarization,
                "summarization_can_call_llm": False,
            }

        try:
            health = self.llm_service.health()
        except Exception:
            return {
                "remote_provider_available": False,
                "offline_available": False,
                "offline_allowed_by_llm_service": False,
                "offline_allowed_for_memory_summarization": self.allow_offline_llm_summarization,
                "summarization_can_call_llm": False,
            }

        remote_available = bool(
            health.get("configured_remote_provider_available", False)
            or health.get("remote_provider_available", False)
        )
        offline_available = bool(health.get("offline_available", False))
        offline_allowed_by_llm_service = bool(health.get("offline_allowed", False))

        summarization_can_call_llm = bool(
            remote_available
            or (
                self.allow_offline_llm_summarization
                and offline_available
                and offline_allowed_by_llm_service
            )
        )

        return {
            "remote_provider_available": remote_available,
            "offline_available": offline_available,
            "offline_allowed_by_llm_service": offline_allowed_by_llm_service,
            "offline_allowed_for_memory_summarization": self.allow_offline_llm_summarization,
            "summarization_can_call_llm": summarization_can_call_llm,
        }

    async def _compact_with_llm(
        self,
        request: MemoryCompactionRequest,
        existing: MemorySummary,
    ) -> LLMCompactionOutcome:
        if self.llm_service is None:
            raise MemoryServiceError(
                "LLM memory summarization requested without LLM service",
                code="memory_llm_service_missing",
            )

        sanitized_payload = self._build_llm_payload(request, existing)
        user_message = json.dumps(sanitized_payload, ensure_ascii=False, separators=(",", ":"))

        llm_request = build_llm_request(
            request_id=request.request_id,
            system_prompt=MEMORY_SYSTEM_PROMPT,
            user_message=user_message,
            temperature=0.1,
            max_output_tokens=1_000,
            metadata={
                "purpose": "memory_compaction",
                "stores_raw_chat": False,
                "input_is_sanitized": True,
            },
        )

        llm_result = await self.llm_service.generate_with_trace(llm_request)
        llm_response = llm_result.response
        provider_used = sanitize_text(llm_response.provider_used or "unknown", 80)

        if _clean_provider_name(provider_used) == "offline" and not self.allow_offline_llm_summarization:
            raise MemoryServiceError(
                "Offline LLM fallback cannot be used for memory summarization",
                code="memory_offline_summarization_disabled",
            )

        payload = self._parse_llm_json(llm_response.text)

        llm_summary = self._summary_from_llm_payload(
            payload,
            user_id_hash=request.user_id_hash,
            existing=existing,
        )

        # LLM summary is primary. Local extraction only runs as fallback (in compact_local).
        # Do not merge both; rely on LLM output for quality/safety.
        result = MemoryCompactionResult(
            request_id=request.request_id,
            user_id_hash=request.user_id_hash,
            summary=llm_summary,
            changed=_summary_changed(existing, llm_summary),
            items_added=len(llm_summary.items),
        )

        return LLMCompactionOutcome(
            result=result,
            provider_used=provider_used,
        )

    def merge_summary_from_llm_and_local(
        self,
        *,
        existing: MemorySummary,
        llm_summary: MemorySummary,
        local_extraction: MemoryExtraction,
        user_id_hash: str,
    ) -> MemorySummary:
        local_summary = self.merge_summary(
            existing,
            local_extraction,
            user_id_hash=user_id_hash,
        )

        summary_text = self._merge_summary_text(
            local_summary.summary,
            tuple(_split_summary_lines(llm_summary.summary)),
        )

        return MemorySummary(
            user_id_hash=user_id_hash,
            preferred_name=llm_summary.preferred_name or local_summary.preferred_name,
            important_people=_merge_important_people(
                local_summary.important_people,
                llm_summary.important_people,
            ),
            relationship_facts=_merge_relationship_facts(
                local_summary.relationship_facts,
                llm_summary.relationship_facts,
            ),
            communication_preferences=_merge_communication_preferences(
                local_summary.communication_preferences,
                llm_summary.communication_preferences,
            ),
            emotional_triggers=_merge_unique(
                local_summary.emotional_triggers,
                llm_summary.emotional_triggers,
            ),
            user_goals=_merge_unique(local_summary.user_goals, llm_summary.user_goals),
            avoided_responses=_merge_unique(
                local_summary.avoided_responses,
                llm_summary.avoided_responses,
            ),
            summary=summary_text,
            known_triggers=_merge_unique(local_summary.known_triggers, llm_summary.known_triggers),
            preferred_coping_tools=_merge_unique(
                local_summary.preferred_coping_tools,
                llm_summary.preferred_coping_tools,
            ),
            goals=_merge_unique(local_summary.goals, llm_summary.goals),
            preferences=_merge_unique(local_summary.preferences, llm_summary.preferences),
            safety_flags=_merge_unique(local_summary.safety_flags, llm_summary.safety_flags),
            items=_merge_memory_items(local_summary.items, llm_summary.items),
            last_safety_level=existing.last_safety_level,
            source=MemorySource.CHAT_COMPACTION,
            version=max(existing.version + 1, local_summary.version, llm_summary.version),
        )

    def _build_llm_payload(
        self,
        request: MemoryCompactionRequest,
        existing: MemorySummary,
    ) -> dict[str, Any]:
        sanitized_interactions: list[dict[str, str]] = []

        for interaction in request.interactions[-MAX_LLM_INTERACTIONS:]:
            sanitized_interactions.append(
                {
                    "role": interaction.role.value,
                    "content": self.redact_text(
                        interaction.content,
                        max_chars=MAX_LLM_INTERACTION_CHARS,
                    ),
                }
            )

        return {
            "locale": request.locale,
            "existing_memory": {
                "preferred_name": existing.preferred_name,
                "important_people": [
                    person.model_dump(mode="json")
                    for person in existing.important_people[:10]
                ],
                "relationship_facts": [
                    fact.model_dump(mode="json")
                    for fact in existing.relationship_facts[:10]
                ],
                "communication_preferences": existing.communication_preferences.model_dump(mode="json"),
                "emotional_triggers": existing.emotional_triggers[:20],
                "user_goals": existing.user_goals[:20],
                "avoided_responses": existing.avoided_responses[:20],
                "summary": self.redact_text(
                    existing.summary,
                    max_chars=MAX_COMPACTED_SUMMARY_CHARS,
                ),
                "known_triggers": existing.known_triggers[:20],
                "preferred_coping_tools": existing.preferred_coping_tools[:20],
                "goals": existing.goals[:20],
                "preferences": existing.preferences[:20],
                "safety_flags": existing.safety_flags[:20],
            },
            "sanitized_interactions": sanitized_interactions,
        }

    def _parse_llm_json(self, text: str) -> dict[str, Any]:
        cleaned = sanitize_text(text, MAX_LLM_JSON_CHARS).strip()
        cleaned = _strip_code_fence(cleaned)
        json_text = _extract_json_object(cleaned)

        try:
            payload = json.loads(json_text)
        except json.JSONDecodeError as exc:
            raise MemoryServiceError(
                "LLM memory response JSON failed to parse",
                code="memory_llm_invalid_json",
            ) from exc

        if not isinstance(payload, dict):
            raise MemoryServiceError(
                "LLM memory response must be a JSON object",
                code="memory_llm_invalid_shape",
            )

        return payload

    def _summary_from_llm_payload(
        self,
        payload: dict[str, Any],
        *,
        user_id_hash: str,
        existing: MemorySummary,
    ) -> MemorySummary:
        try:
            return MemorySummary(
                user_id_hash=user_id_hash,
                preferred_name=self._clean_optional_name(payload.get("preferred_name")),
                important_people=self._important_people_from_payload(payload.get("important_people", [])),
                relationship_facts=self._relationship_facts_from_payload(payload.get("relationship_facts", [])),
                communication_preferences=self._communication_preferences_from_payload(
                    payload.get("communication_preferences", {})
                ),
                emotional_triggers=_clean_memory_list(payload.get("emotional_triggers", [])),
                user_goals=_clean_memory_list(payload.get("user_goals", [])),
                avoided_responses=_clean_memory_list(payload.get("avoided_responses", [])),
                summary=self.redact_text(
                    str(payload.get("summary", "")),
                    max_chars=MAX_COMPACTED_SUMMARY_CHARS,
                ),
                known_triggers=_clean_memory_list(payload.get("known_triggers", [])),
                preferred_coping_tools=_clean_memory_list(
                    payload.get("preferred_coping_tools", [])
                ),
                goals=_clean_memory_list(payload.get("goals", [])),
                preferences=_clean_memory_list(payload.get("preferences", [])),
                safety_flags=_clean_memory_list(payload.get("safety_flags", [])),
                items=self._items_from_llm_payload(payload.get("items", [])),
                last_safety_level=existing.last_safety_level,
                source=MemorySource.CHAT_COMPACTION,
                version=max(1, existing.version + 1),
            )
        except (PydanticValidationError, TypeError, ValueError) as exc:
            raise MemoryServiceError(
                "LLM memory response failed validation",
                code="memory_llm_validation_failed",
            ) from exc

    def _clean_optional_name(self, value: Any) -> str | None:
        if value is None:
            return None
        cleaned = self.redact_text(str(value or ""), max_chars=160)
        return cleaned or None

    def _important_people_from_payload(self, raw_people: Any) -> list[ImportantPerson]:
        if not isinstance(raw_people, list):
            return []

        people: list[ImportantPerson] = []

        for raw in raw_people[:MAX_ITEMS_PER_COMPACTION]:
            if not isinstance(raw, dict):
                continue

            name = self.redact_text(
                str(raw.get("canonical_name") or raw.get("name") or ""),
                max_chars=160,
            )

            if not name:
                continue

            try:
                people.append(
                    ImportantPerson(
                        canonical_name=name,
                        aliases=_clean_memory_list(raw.get("aliases", []))[:20],
                        relationship=self.redact_text(
                            str(raw.get("relationship") or ""),
                            max_chars=160,
                        ),
                        notes=_clean_memory_list(raw.get("notes", []))[:20],
                        confidence=_bounded_float(raw.get("confidence", 0.65), default=0.65),
                    )
                )
            except (PydanticValidationError, TypeError, ValueError):
                continue

        return people

    def _relationship_facts_from_payload(self, raw_facts: Any) -> list[RelationshipFact]:
        if not isinstance(raw_facts, list):
            return []

        facts: list[RelationshipFact] = []

        for raw in raw_facts[:MAX_ITEMS_PER_COMPACTION]:
            if not isinstance(raw, dict):
                continue

            summary = self.redact_text(str(raw.get("summary") or ""), max_chars=500)
            if not summary:
                continue

            try:
                facts.append(
                    RelationshipFact(
                        summary=summary,
                        people=_clean_memory_list(raw.get("people", []))[:20],
                        confidence=_bounded_float(raw.get("confidence", 0.65), default=0.65),
                    )
                )
            except (PydanticValidationError, TypeError, ValueError):
                continue

        return facts

    def _communication_preferences_from_payload(self, raw: Any) -> CommunicationPreferences:
        if not isinstance(raw, dict):
            return CommunicationPreferences()

        return CommunicationPreferences(
            tone=self.redact_text(str(raw.get("tone") or ""), max_chars=160),
            language=self.redact_text(str(raw.get("language") or ""), max_chars=160),
            response_style=_clean_memory_list(raw.get("response_style", [])),
            avoid=_clean_memory_list(raw.get("avoid", [])),
        )

    def _items_from_llm_payload(self, raw_items: Any) -> list[MemoryItem]:
        if raw_items is None:
            return []

        if not isinstance(raw_items, list):
            raise MemoryServiceError(
                "LLM memory items must be a list",
                code="memory_llm_invalid_items",
            )

        items: list[MemoryItem] = []

        for raw in raw_items[:MAX_ITEMS_PER_COMPACTION]:
            if not isinstance(raw, dict):
                continue

            category = _parse_memory_category(raw.get("category"))
            sensitivity = _parse_memory_sensitivity(raw.get("sensitivity"))
            text = self.redact_text(
                str(raw.get("text", "")),
                max_chars=MAX_EXTRACTED_ITEM_TEXT_CHARS,
            )

            if not text:
                continue

            items.append(
                MemoryItem(
                    category=category,
                    text=text,
                    source=MemorySource.CHAT_COMPACTION,
                    sensitivity=sensitivity,
                    confidence=_bounded_float(raw.get("confidence", 0.55), default=0.55),
                    tags=[category.value, "llm_compaction"],
                )
            )

        return items

    def _extract_preferred_name(self, text: str) -> str | None:
        for pattern in _PREFERRED_NAME_PATTERNS:
            match = pattern.search(text)
            if not match:
                continue

            name = _clean_person_name(self.redact_text(match.group(1), max_chars=160))
            if name:
                return name

        return None

    def _extract_important_people(self, text: str) -> list[ImportantPerson]:
        people: list[ImportantPerson] = []

        for relationship, pattern in _IMPORTANT_PERSON_PATTERNS:
            for match in pattern.finditer(text):
                name, aliases = _split_name_and_aliases(
                    self.redact_text(match.group(1), max_chars=220)
                )

                if not name:
                    continue

                people.append(
                    ImportantPerson(
                        canonical_name=name,
                        aliases=aliases,
                        relationship=relationship,
                        confidence=0.9,
                    )
                )

        aliases = self._extract_standalone_aliases(text)
        if aliases and people:
            first = people[0]
            people[0] = first.model_copy(
                update={
                    "aliases": _merge_unique(first.aliases, aliases)[:20],
                    "confidence": max(first.confidence, 0.92),
                }
            )

        return people[:MAX_ITEMS_PER_COMPACTION]

    def _extract_standalone_aliases(self, text: str) -> list[str]:
        aliases: list[str] = []

        for pattern in _ALIAS_PATTERNS:
            match = pattern.search(text.strip())
            if not match:
                continue

            aliases.extend(_extract_aliases(match.group(1)))

        return _unique_clean(aliases)[:20]

    def _extract_relationship_facts(
        self,
        text: str,
        people: list[ImportantPerson],
    ) -> list[RelationshipFact]:
        lowered = text.lower()
        facts: list[RelationshipFact] = []
        person_names = [person.canonical_name for person in people]

        if any(token in lowered for token in ("relationship", "girlfriend", "boyfriend", "partner", "trust", "overthinking")) or any(
            token in text for token in ("حبيبتي", "حبيبي", "العلاقة", "ثقة", "بيقلل", "بيتحكم")
        ):
            facts.append(
                RelationshipFact(
                    summary="User has active relationship context that may affect support needs.",
                    people=person_names,
                    confidence=0.68,
                )
            )

        if any(token in lowered for token in ("trust", "hidden", "deleted chat", "concealment")) or any(
            token in text for token in ("ثقة", "خبى", "خبت", "مخبي")
        ):
            facts.append(
                RelationshipFact(
                    summary="Trust and concealment are important relationship themes for the user.",
                    people=person_names,
                    confidence=0.85,
                )
            )

        return facts

    def _extract_communication_preferences(self, text: str) -> CommunicationPreferences:
        response_style: list[str] = []
        avoid: list[str] = []
        tone = ""
        language = ""

        if _DIRECT_STYLE_RE.search(text):
            tone = "direct"
            response_style.extend(["direct answers", "concise practical guidance"])

        if _EGYPTIAN_ARABIC_RE.search(text) or _contains_egyptian_arabic(text):
            language = "Egyptian Arabic when the user writes Egyptian Arabic"

        if any(token in text for token in ("مش عايز أسئلة هوية", "مش عايز اسئلة هوية")):
            avoid.append("random identity questions")

        return CommunicationPreferences(
            tone=tone,
            language=language,
            response_style=response_style,
            avoid=avoid,
        )

    def _extract_avoided_responses(self, text: str) -> list[str]:
        avoided: list[str] = []

        for match in _AVOID_RESPONSE_RE.finditer(text):
            fragment = _clean_captured_fragment(self.redact_text(match.group(1), max_chars=160))
            if fragment:
                avoided.append(fragment)

        if "random identity questions" in text.lower() or "اسئلة هوية" in text:
            avoided.append("random identity questions")

        if "formal msa" in text.lower() or "فصحى" in text:
            avoided.append("formal MSA when user writes dialect")

        return _unique_clean(avoided)

    def _extract_named_patterns(
        self,
        text: str,
        patterns: tuple[tuple[str, re.Pattern[str]], ...],
    ) -> list[str]:
        return _unique_clean([label for label, pattern in patterns if pattern.search(text)])

    def _extract_capture_patterns(
        self,
        text: str,
        patterns: tuple[re.Pattern[str], ...],
    ) -> list[str]:
        output: list[str] = []

        for pattern in patterns:
            for match in pattern.finditer(text):
                captured = self.redact_text(
                    match.group(1),
                    max_chars=MAX_EXTRACTED_ITEM_TEXT_CHARS,
                )
                captured = _clean_captured_fragment(captured)

                if captured:
                    output.append(captured)

        return _unique_clean(output)[:MAX_LIST_FIELD_ITEMS]

    def _extract_summary_sentences(self, text: str) -> list[str]:
        scored: list[tuple[int, str]] = []

        for sentence in _split_sentences(text):
            score = 0
            lowered = sentence.lower()

            for _, pattern in _TRIGGER_PATTERNS + _COPING_PATTERNS + _SAFETY_FLAG_PATTERNS:
                if pattern.search(sentence):
                    score += 3

            if any(
                word in lowered
                for word in ("i feel", "i want", "i prefer", "انا", "أنا", "حاسس", "عايز")
            ):
                score += 1

            if _EMAIL_OR_PHONE_PLACEHOLDER_RE.search(sentence):
                score -= 1

            if score > 0:
                scored.append((score, sentence))

        scored.sort(key=lambda item: (item[0], len(item[1])), reverse=True)
        return _unique_clean([sentence for _, sentence in scored[:6]])

    def _build_memory_items(
        self,
        *,
        triggers: list[str],
        coping_tools: list[str],
        goals: list[str],
        preferences: list[str],
        safety_flags: list[str],
    ) -> list[MemoryItem]:
        items: list[MemoryItem] = []

        for trigger in triggers:
            items.append(
                MemoryItem(
                    category=MemoryCategory.TRIGGER,
                    text=f"Possible trigger: {trigger}",
                    source=MemorySource.CHAT_COMPACTION,
                    sensitivity=MemorySensitivity.MEDIUM,
                    confidence=0.65,
                    tags=["trigger", trigger],
                )
            )

        for tool in coping_tools:
            items.append(
                MemoryItem(
                    category=MemoryCategory.COPING_TOOL,
                    text=f"Possible preferred coping tool: {tool}",
                    source=MemorySource.CHAT_COMPACTION,
                    sensitivity=MemorySensitivity.LOW,
                    confidence=0.6,
                    tags=["coping_tool", tool],
                )
            )

        for goal in goals:
            items.append(
                MemoryItem(
                    category=MemoryCategory.GOAL,
                    text=f"Stated wellness goal: {goal}",
                    source=MemorySource.CHAT_COMPACTION,
                    sensitivity=MemorySensitivity.MEDIUM,
                    confidence=0.55,
                    tags=["goal"],
                )
            )

        for preference in preferences:
            items.append(
                MemoryItem(
                    category=MemoryCategory.PREFERENCE,
                    text=f"Communication/support preference: {preference}",
                    source=MemorySource.CHAT_COMPACTION,
                    sensitivity=MemorySensitivity.LOW,
                    confidence=0.55,
                    tags=["preference"],
                )
            )

        for flag in safety_flags:
            items.append(
                MemoryItem(
                    category=MemoryCategory.SAFETY_FLAG,
                    text=f"Safety flag observed: {flag}",
                    source=MemorySource.CHAT_COMPACTION,
                    sensitivity=MemorySensitivity.HIGH,
                    confidence=0.75,
                    tags=["safety_flag", flag],
                )
            )

        return items[:MAX_ITEMS_PER_COMPACTION]

    def _merge_summary_text(
        self,
        existing_summary: str,
        new_sentences: tuple[str, ...],
    ) -> str:
        lines: list[str] = []

        if existing_summary:
            lines.extend(_split_summary_lines(existing_summary))

        lines.extend(new_sentences)

        cleaned_lines = _unique_clean(lines)
        merged = "\n".join(f"- {line}" for line in cleaned_lines[:20])

        return self.redact_text(
            merged,
            max_chars=min(self.summary_max_chars, MAX_COMPACTED_SUMMARY_CHARS),
        )


def _setting_value(settings: Settings, name: str, default: Any = None) -> Any:
    value = getattr(settings, name, None)

    if value is None:
        return os.getenv(name, default)

    if hasattr(value, "get_secret_value"):
        return value.get_secret_value()

    return value


def _setting_bool(settings: Settings, name: str, *, default: bool) -> bool:
    value = _setting_value(settings, name, None)

    if value is None:
        return default

    if isinstance(value, bool):
        return value

    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _is_production(settings: Settings) -> bool:
    value = _setting_value(settings, "ENVIRONMENT", "development")
    environment = sanitize_text(str(value or "development"), 80).lower()
    return environment in {"production", "prod"}


def _clean_provider_name(value: str) -> str:
    return sanitize_text(str(value or ""), 80).lower() or "unknown"


def build_memory_interactions(
    *,
    user_messages: list[str] | tuple[str, ...] = (),
    assistant_messages: list[str] | tuple[str, ...] = (),
) -> list[MemoryInteraction]:
    interactions: list[MemoryInteraction] = []

    for message in user_messages:
        interactions.append(
            MemoryInteraction(
                role=MemoryInteractionRole.USER,
                content=message,
            )
        )

    for message in assistant_messages:
        interactions.append(
            MemoryInteraction(
                role=MemoryInteractionRole.ASSISTANT,
                content=message,
            )
        )

    return interactions


def _redact_memory_sensitive(text: str) -> str:
    value = redact_basic_pii(str(text or ""))
    value = _MEMORY_EMAIL_RE.sub("[redacted_email]", value)

    def redact_phone(match: re.Match[str]) -> str:
        candidate = match.group(0)
        return "[redacted_phone]" if sum(char.isdigit() for char in candidate) >= 9 else candidate

    value = _MEMORY_PHONE_RE.sub(redact_phone, value)
    value = _MEMORY_BEARER_RE.sub("[redacted_secret]", value)
    value = _MEMORY_KEY_VALUE_SECRET_RE.sub(
        lambda match: f"{match.group(1)}=[redacted_secret]",
        value,
    )
    value = _MEMORY_LONG_TOKEN_RE.sub("[redacted_secret]", value)

    return value


def _strip_instruction_prefixes(text: str) -> str:
    """
    Remove injected instruction prefixes from message text.
    Prefixes like 'Saved user memory:', 'Verified authenticated user context:', etc.
    should not be included in memory extraction.
    """
    lines = text.split("\n")
    filtered_lines = []
    skip_until_user_message = False

    for line in lines:
        lower = line.lower().strip()

        # Skip lines that are clearly instruction sections
        if any(
            lower.startswith(marker)
            for marker in [
                "saved user memory:",
                "verified authenticated",
                "assistant instruction:",
                "user message:",
                "communication preferences",
                "user communication preferences",
            ]
        ):
            skip_until_user_message = True
            continue

        # Stop skipping when we hit "User message:" marker
        if skip_until_user_message and lower == "user message:":
            skip_until_user_message = False
            continue

        # If we're in the instruction section, skip this line
        if skip_until_user_message:
            continue

        filtered_lines.append(line)

    return "\n".join(filtered_lines).strip()


def _summary_changed(existing: MemorySummary, new: MemorySummary) -> bool:
    existing_payload = existing.model_dump(mode="json", exclude={"updated_at", "version"})
    new_payload = new.model_dump(mode="json", exclude={"updated_at", "version"})
    return existing_payload != new_payload


def _strip_code_fence(text: str) -> str:
    stripped = text.strip()

    if not stripped.startswith("```"):
        return stripped

    lines = stripped.splitlines()

    if lines and lines[0].startswith("```"):
        lines = lines[1:]

    if lines and lines[-1].strip().startswith("```"):
        lines = lines[:-1]

    return "\n".join(lines).strip()


def _extract_json_object(text: str) -> str:
    stripped = text.strip()

    if stripped.startswith("{") and stripped.endswith("}"):
        return stripped

    start = stripped.find("{")

    if start == -1:
        raise MemoryServiceError(
            "LLM memory response did not contain JSON",
            code="memory_llm_invalid_json",
        )

    depth = 0
    in_string = False
    escaped = False

    for index in range(start, len(stripped)):
        char = stripped[index]

        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue

        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1

            if depth == 0:
                return stripped[start : index + 1]

    raise MemoryServiceError(
        "LLM memory response JSON object was incomplete",
        code="memory_llm_invalid_json",
    )


def _split_sentences(text: str) -> list[str]:
    normalized = sanitize_text(text, MAX_COMPACTED_SUMMARY_CHARS)
    parts = re.split(r"(?<=[.!؟?])\s+|\n+", normalized)

    return [
        safe_truncate(part.strip(" -•\t"), MAX_EXTRACTED_ITEM_TEXT_CHARS)
        for part in parts
        if 8 <= len(part.strip()) <= MAX_EXTRACTED_ITEM_TEXT_CHARS
    ]


def _split_summary_lines(text: str) -> list[str]:
    return [
        line.strip(" -•\t")
        for line in text.splitlines()
        if line.strip(" -•\t")
    ]


def _clean_captured_fragment(text: str) -> str:
    cleaned = text.strip(" .!؟?،,;:-\n\t")
    cleaned = re.sub(r"\s+", " ", cleaned)

    if len(cleaned) < 3:
        return ""

    if len(cleaned.split()) > 24:
        cleaned = " ".join(cleaned.split()[:24])

    return safe_truncate(cleaned, MAX_EXTRACTED_ITEM_TEXT_CHARS)


def _unique_clean(values: list[str] | tuple[str, ...]) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []

    for value in values:
        cleaned = _redact_memory_sensitive(
            sanitize_text(str(value or ""), MAX_EXTRACTED_ITEM_TEXT_CHARS)
        )

        if not cleaned:
            continue

        key = cleaned.lower()

        if key in seen:
            continue

        seen.add(key)
        output.append(cleaned)

        if len(output) >= MAX_LIST_FIELD_ITEMS:
            break

    return output


def _merge_unique(
    existing: list[str],
    new_values: tuple[str, ...] | list[str],
) -> list[str]:
    return _unique_clean(list(existing) + list(new_values))[:MAX_LIST_FIELD_ITEMS]


def _merge_memory_items(
    existing: list[MemoryItem],
    new_items: list[MemoryItem],
) -> list[MemoryItem]:
    merged: list[MemoryItem] = []
    seen: set[tuple[str, str]] = set()

    for item in list(existing) + list(new_items):
        key = (item.category.value, item.text.lower())

        if key in seen:
            continue

        seen.add(key)
        merged.append(item)

        if len(merged) >= MAX_LIST_FIELD_ITEMS:
            break

    return merged


def _merge_important_people(
    existing: list[ImportantPerson],
    new_people: list[ImportantPerson],
) -> list[ImportantPerson]:
    merged: list[ImportantPerson] = []

    for person in list(existing) + list(new_people):
        if not person.canonical_name:
            continue

        match_index = _find_matching_person_index(merged, person)

        if match_index < 0:
            merged.append(person)
            continue

        current = merged[match_index]
        merged[match_index] = ImportantPerson(
            canonical_name=current.canonical_name,
            aliases=_merge_unique(current.aliases, person.aliases)[:20],
            relationship=person.relationship or current.relationship,
            notes=_merge_unique(current.notes, person.notes),
            confidence=max(current.confidence, person.confidence),
            updated_at=max(current.updated_at, person.updated_at),
        )

        if len(merged) >= MAX_LIST_FIELD_ITEMS:
            break

    return merged[:MAX_LIST_FIELD_ITEMS]


def _find_matching_person_index(people: list[ImportantPerson], candidate: ImportantPerson) -> int:
    candidate_aliases = {_memory_key(alias) for alias in [candidate.canonical_name, *candidate.aliases] if alias}

    for index, person in enumerate(people):
        person_aliases = {_memory_key(alias) for alias in [person.canonical_name, *person.aliases] if alias}

        if candidate_aliases.intersection(person_aliases):
            return index

    intimate_relationships = {"girlfriend", "boyfriend", "partner", "spouse"}
    relationship = _memory_key(candidate.relationship)

    if relationship in intimate_relationships:
        matching_relationship_indexes = [
            index
            for index, person in enumerate(people)
            if _memory_key(person.relationship) == relationship
        ]

        if len(matching_relationship_indexes) == 1:
            return matching_relationship_indexes[0]

    return -1


def _merge_relationship_facts(
    existing: list[RelationshipFact],
    new_facts: list[RelationshipFact],
) -> list[RelationshipFact]:
    merged: list[RelationshipFact] = []
    seen: set[str] = set()

    for fact in list(existing) + list(new_facts):
        key = _memory_key(fact.summary)
        if not key or key in seen:
            continue

        seen.add(key)
        merged.append(fact)

        if len(merged) >= MAX_LIST_FIELD_ITEMS:
            break

    return merged


def _merge_communication_preferences(
    existing: CommunicationPreferences,
    new: CommunicationPreferences,
) -> CommunicationPreferences:
    return CommunicationPreferences(
        tone=new.tone or existing.tone,
        language=new.language or existing.language,
        response_style=_merge_unique(existing.response_style, new.response_style),
        avoid=_merge_unique(existing.avoid, new.avoid),
    )


def _clean_memory_list(value: Any) -> list[str]:
    if value is None:
        return []

    if isinstance(value, str):
        raw_items = [value]
    elif isinstance(value, list):
        raw_items = value
    else:
        raw_items = [value]

    return _unique_clean(
        [
            safe_truncate(
                _redact_memory_sensitive(sanitize_text(str(item or ""), 220)),
                220,
            )
            for item in raw_items[:MAX_LIST_FIELD_ITEMS]
        ]
    )


def _parse_memory_category(value: Any) -> MemoryCategory:
    raw = sanitize_text(str(value or ""), 80)

    try:
        return MemoryCategory(raw)
    except ValueError:
        return MemoryCategory.OTHER


def _parse_memory_sensitivity(value: Any) -> MemorySensitivity:
    raw = sanitize_text(str(value or ""), 80)

    try:
        return MemorySensitivity(raw)
    except ValueError:
        return MemorySensitivity.MEDIUM


def _bounded_float(value: Any, *, default: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default

    return max(0.0, min(parsed, 1.0))


def _split_name_and_aliases(value: str) -> tuple[str, list[str]]:
    aliases = _extract_aliases(value)
    name = aliases[0] if aliases else _clean_person_name(value)
    return name, _merge_unique([name], aliases) if name else []


def _extract_aliases(value: str) -> list[str]:
    raw = re.sub(r"(?i)\b(?:or|aka|also known as|also|may write|write her name as|write his name as)\b", ",", value)
    raw = raw.replace("أو", ",").replace("او", ",").replace("/", ",")
    return _unique_clean([_clean_person_name(part) for part in raw.split(",")])


def _clean_person_name(value: str) -> str:
    cleaned = sanitize_text(str(value or ""), 160)
    cleaned = re.sub(r"\s+", " ", cleaned)
    cleaned = cleaned.strip(" .,!?:;،؟'\"“”")

    if not cleaned:
        return ""

    stop_phrases = (
        "and",
        "but",
        "because",
        "when",
        "who",
        "that",
    )

    words = cleaned.split()
    if len(words) > 6:
        words = words[:6]
    cleaned = " ".join(words)

    if cleaned.lower() in stop_phrases:
        return ""

    return cleaned


def _memory_key(value: str) -> str:
    return re.sub(r"\s+", " ", sanitize_text(str(value or ""), 220)).strip().lower()


def _contains_egyptian_arabic(text: str) -> bool:
    return any(
        marker in text
        for marker in (
            "مش",
            "عايز",
            "عايزة",
            "ازاي",
            "بحس",
            "حاسس",
            "حاسة",
            "دلوقتي",
            "بيقلل",
            "بيتحكم",
        )
    )
