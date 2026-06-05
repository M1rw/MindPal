# backend/services/rag_service.py

from __future__ import annotations

import json
import math
import os
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import yaml

from backend.core.config import Settings, get_settings
from backend.core.errors import RAGError
from backend.core.prompts import VALID_RAG_TAGS
from backend.core.security import normalize_locale, safe_truncate, sanitize_text
from backend.models.chat import RagReference
from backend.services.llm_service import LLMService, build_llm_request


MAX_QUERY_CHARS = 2_000
MAX_MEMORY_CONTEXT_CHARS = 1_200
MAX_UNIT_TEXT_CHARS = 1_500
MAX_TRIGGER_CHARS = 120
MAX_INSTRUCTION_CHARS = 500
MAX_RESPONSE_STYLE_ITEMS = 12
MAX_LLM_PLAN_CHARS = 6_000
DEFAULT_MAX_RESULTS = 4
PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CORPUS_DIR = Path(__file__).resolve().parents[1] / "rag" / "corpus"
CLINICAL_FRAMEWORKS_DIR = PROJECT_ROOT / "data" / "clinical_frameworks"

_WORD_RE = re.compile(r"[\w\u0600-\u06FF']+", re.UNICODE)
_JSON_OBJECT_RE = re.compile(r"\{.*\}", re.DOTALL)

RAG_PLANNER_SYSTEM_PROMPT = """
You are MindPal's RAG retrieval planner.

Your job is to convert a sanitized user message into retrieval tags for a curated wellness grounding corpus.

Rules:
- Return JSON only.
- Do not diagnose.
- Do not give therapy or medical claims.
- Do not include raw private details.
- Do not invent crisis handling.
- Prefer practical wellness technique tags.
- Use the user's language only to understand meaning; output tags in stable snake_case or short English phrases.

Available common tags:
panic_grounding
54321_grounding
box_breathing
dbt_stop
urge_surfing
emotion_labeling
reframing
anxiety
grounding
breathing
emotion_regulation
anger
impulse
delay
cognitive_support
self_criticism
reflection

Return exactly:
{
  "rewritten_query": "short retrieval query",
  "tags": ["tag"],
  "categories": ["category"],
  "techniques": ["technique"],
  "contraindications": ["short caution"],
  "locale": "en|ar|auto"
}
""".strip()


@dataclass(frozen=True, slots=True)
class GroundingUnit:
    grounding_id: str
    category: str
    technique: str
    trigger_terms: tuple[str, ...]
    instructions: tuple[str, ...]
    contraindications: tuple[str, ...]
    response_style: tuple[str, ...]
    tags: tuple[str, ...]
    source: str = "curated"

    def to_prompt_dict(self, *, score: float | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "grounding_id": self.grounding_id,
            "category": self.category,
            "technique": self.technique,
            "trigger_terms": list(self.trigger_terms),
            "instructions": list(self.instructions),
            "contraindications": list(self.contraindications),
            "response_style": list(self.response_style),
            "source": self.source,
        }

        if score is not None:
            payload["score"] = round(max(0.0, min(float(score), 1.0)), 4)

        return payload

    def to_reference(self, *, score: float) -> RagReference:
        return RagReference(
            grounding_id=self.grounding_id,
            category=self.category,
            technique=self.technique,
            score=score,
        )


@dataclass(frozen=True, slots=True)
class RetrievalMatch:
    unit: GroundingUnit
    score: float
    matched_terms: tuple[str, ...]

    def to_prompt_dict(self) -> dict[str, Any]:
        payload = self.unit.to_prompt_dict(score=self.score)
        payload["matched_terms"] = list(self.matched_terms)
        return payload

    def to_reference(self) -> RagReference:
        return self.unit.to_reference(score=self.score)


@dataclass(frozen=True, slots=True)
class RAGQueryPlan:
    rewritten_query: str
    tags: tuple[str, ...]
    categories: tuple[str, ...]
    techniques: tuple[str, ...]
    contraindications: tuple[str, ...]
    locale: str
    source: str

    def combined_terms(self) -> tuple[str, ...]:
        return _clean_terms(
            list(self.tags)
            + list(self.categories)
            + list(self.techniques)
            + list(self.contraindications)
        )


@dataclass(frozen=True, slots=True)
class RAGRetrievalResult:
    matches: tuple[RetrievalMatch, ...]
    prompt_grounding: tuple[dict[str, Any], ...]
    references: tuple[RagReference, ...]
    plan: RAGQueryPlan
    used_llm_plan: bool
    fallback_used: bool
    planner_provider: str | None = None
    error_code: str | None = None

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "references": [reference.model_dump(mode="json") for reference in self.references],
            "plan": asdict(self.plan),
            "used_llm_plan": self.used_llm_plan,
            "fallback_used": self.fallback_used,
            "planner_provider": self.planner_provider,
            "error_code": self.error_code,
        }


class RAGService:
    """
    Curated RAG service with LLM-assisted retrieval planning.

    Primary path:
    - LLM planner extracts retrieval query/tags from user message, locale,
      safety tags, and sanitized memory context.
    - Local curated retrieval ranks reviewed grounding units.

    Fallback path:
    - deterministic query/tag expansion and local scoring.

    This service intentionally does not require Pinecone, Qdrant, embeddings,
    network calls, or raw PDF retrieval.
    """

    def __init__(
        self,
        corpus_dir: Path | None = None,
        *,
        settings: Settings | None = None,
        llm_service: LLMService | None = None,
        enable_llm_planning: bool | None = None,
        use_builtin_fallback: bool | None = None,
        allow_builtin_fallback_in_production: bool | None = None,
        allow_offline_llm_planner: bool | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.production_mode = _is_production(self.settings)

        self.corpus_dir = corpus_dir or DEFAULT_CORPUS_DIR
        self.corpus_dirs = _unique_paths((self.corpus_dir, CLINICAL_FRAMEWORKS_DIR))
        self.llm_service = llm_service

        self.enable_llm_planning = (
            _setting_bool(
                self.settings,
                "ENABLE_LLM_RAG_PLANNING",
                default=True,
            )
            if enable_llm_planning is None
            else bool(enable_llm_planning)
        )

        self.use_builtin_fallback = (
            _setting_bool(
                self.settings,
                "ENABLE_BUILTIN_RAG_FALLBACK",
                default=not self.production_mode,
            )
            if use_builtin_fallback is None
            else bool(use_builtin_fallback)
        )

        self.allow_builtin_fallback_in_production = (
            _setting_bool(
                self.settings,
                "ALLOW_BUILTIN_RAG_FALLBACK_IN_PRODUCTION",
                default=False,
            )
            if allow_builtin_fallback_in_production is None
            else bool(allow_builtin_fallback_in_production)
        )

        self.allow_offline_llm_planner = (
            _setting_bool(
                self.settings,
                "ALLOW_OFFLINE_LLM_RAG_PLANNER",
                default=False,
            )
            if allow_offline_llm_planner is None
            else bool(allow_offline_llm_planner)
        )

        self._units: tuple[GroundingUnit, ...] = ()
        self._failed_files: tuple[dict[str, str], ...] = ()
        self._loaded_files: tuple[str, ...] = ()
        self._last_result: RAGRetrievalResult | None = None
        self._using_builtin_fallback = False

        self.reload()

    @property
    def units(self) -> tuple[GroundingUnit, ...]:
        return self._units

    @property
    def last_result(self) -> RAGRetrievalResult | None:
        return self._last_result

    def reload(self) -> None:
        loaded_units: list[GroundingUnit] = []
        loaded_files: list[str] = []
        failed_files: list[dict[str, str]] = []
        self._using_builtin_fallback = False

        for corpus_dir in self.corpus_dirs:
            if not corpus_dir.exists():
                continue

            for path in _iter_yaml_files(corpus_dir):
                try:
                    units = self._load_yaml_units(path)
                except RAGError as exc:
                    failed_files.append(
                        {
                            "path": str(path),
                            "code": sanitize_text(getattr(exc, "code", "") or exc.__class__.__name__, 120),
                            "message": sanitize_text(str(exc), 300),
                        }
                    )
                    continue

                loaded_units.extend(units)
                loaded_files.append(str(path))

        if loaded_units:
            self._assert_unique_ids(loaded_units)
            self._units = tuple(loaded_units)
            self._loaded_files = tuple(loaded_files)
            self._failed_files = tuple(failed_files)
            return

        if self.production_mode and not self.allow_builtin_fallback_in_production:
            raise RAGError(
                "RAG corpus is missing or empty in production",
                code="rag_corpus_missing_in_production",
                details={
                    "corpus_dirs": [str(path) for path in self.corpus_dirs],
                    "failed_files": failed_files,
                },
            )

        if self.use_builtin_fallback:
            loaded_units = list(_builtin_units())
            self._using_builtin_fallback = True

        if not loaded_units:
            raise RAGError(
                "RAG corpus is missing or empty",
                code="rag_corpus_missing",
                details={
                    "corpus_dirs": [str(path) for path in self.corpus_dirs],
                    "failed_files": failed_files,
                },
            )

        self._assert_unique_ids(loaded_units)
        self._units = tuple(loaded_units)
        self._loaded_files = tuple(loaded_files)
        self._failed_files = tuple(failed_files)

    async def retrieve_contextual(
        self,
        message: str,
        *,
        safety_tags: list[str] | tuple[str, ...] | None = None,
        locale: str | None = "auto",
        memory_summary: str | None = None,
        max_results: int = DEFAULT_MAX_RESULTS,
    ) -> RAGRetrievalResult:
        """
        LLM-primary retrieval planning with deterministic local fallback.

        Future chat_router should call this method.
        """
        cleaned_message = sanitize_text(message, MAX_QUERY_CHARS)
        cleaned_safety_tags = _clean_terms(safety_tags or ())
        resolved_locale = normalize_locale(locale)

        if not cleaned_message and not cleaned_safety_tags:
            empty_plan = self._build_local_plan(
                "",
                safety_tags=cleaned_safety_tags,
                locale=resolved_locale,
                memory_summary=memory_summary,
                source="empty",
            )
            result = self._result_from_plan(
                empty_plan,
                max_results=max_results,
                used_llm_plan=False,
                fallback_used=True,
                error_code="empty_query",
            )
            self._last_result = result
            return result

        planner_state = self._planner_provider_state()

        if self.enable_llm_planning and self.llm_service is not None and planner_state["planner_can_call_llm"]:
            try:
                plan, provider_used = await self._build_llm_plan(
                    cleaned_message,
                    safety_tags=cleaned_safety_tags,
                    locale=resolved_locale,
                    memory_summary=memory_summary,
                )
                result = self._result_from_plan(
                    plan,
                    max_results=max_results,
                    used_llm_plan=True,
                    fallback_used=False,
                    planner_provider=provider_used,
                )
                self._last_result = result
                return result
            except Exception as exc:
                plan = self._build_local_plan(
                    cleaned_message,
                    safety_tags=cleaned_safety_tags,
                    locale=resolved_locale,
                    memory_summary=memory_summary,
                    source="local_fallback_after_llm_failure",
                )
                result = self._result_from_plan(
                    plan,
                    max_results=max_results,
                    used_llm_plan=True,
                    fallback_used=True,
                    error_code=exc.__class__.__name__,
                )
                self._last_result = result
                return result

        plan = self._build_local_plan(
            cleaned_message,
            safety_tags=cleaned_safety_tags,
            locale=resolved_locale,
            memory_summary=memory_summary,
            source="local_only",
        )
        result = self._result_from_plan(
            plan,
            max_results=max_results,
            used_llm_plan=False,
            fallback_used=True,
            error_code="llm_planner_missing_or_disabled",
        )
        self._last_result = result
        return result

    def retrieve(
        self,
        query: str,
        *,
        tags: list[str] | tuple[str, ...] | None = None,
        max_results: int = DEFAULT_MAX_RESULTS,
        min_score: float = 0.08,
    ) -> list[RetrievalMatch]:
        """
        Deterministic local retrieval.

        Kept for tests, fallback, and simple non-agent paths.
        """
        cleaned_query = sanitize_text(query, MAX_QUERY_CHARS)
        cleaned_tags = _clean_terms(tags or ())

        if not cleaned_query and not cleaned_tags:
            return []

        if max_results <= 0:
            return []

        query_tokens = _tokenize(cleaned_query)
        query_lower = cleaned_query.lower()

        matches: list[RetrievalMatch] = []

        for unit in self._units:
            score, matched_terms = _score_unit(
                unit,
                query_lower=query_lower,
                query_tokens=query_tokens,
                requested_tags=cleaned_tags,
            )

            if score < min_score:
                continue

            matches.append(
                RetrievalMatch(
                    unit=unit,
                    score=round(max(0.0, min(score, 1.0)), 4),
                    matched_terms=tuple(matched_terms),
                )
            )

        matches.sort(
            key=lambda item: (
                item.score,
                len(item.matched_terms),
                item.unit.category,
                item.unit.technique,
            ),
            reverse=True,
        )

        return matches[:max_results]

    def retrieve_prompt_grounding(
        self,
        query: str,
        *,
        tags: list[str] | tuple[str, ...] | None = None,
        max_results: int = DEFAULT_MAX_RESULTS,
    ) -> list[dict[str, Any]]:
        return [
            match.to_prompt_dict()
            for match in self.retrieve(query, tags=tags, max_results=max_results)
        ]

    def retrieve_references(
        self,
        query: str,
        *,
        tags: list[str] | tuple[str, ...] | None = None,
        max_results: int = DEFAULT_MAX_RESULTS,
    ) -> list[RagReference]:
        return [
            match.to_reference()
            for match in self.retrieve(query, tags=tags, max_results=max_results)
        ]

    def retrieve_for_tags(
        self,
        tags: list[str] | tuple[str, ...],
        *,
        max_results: int = DEFAULT_MAX_RESULTS,
    ) -> list[RetrievalMatch]:
        return self.retrieve("", tags=tags, max_results=max_results, min_score=0.15)

    def health(self) -> dict[str, Any]:
        categories = sorted({unit.category for unit in self._units})
        tags = sorted({tag for unit in self._units for tag in unit.tags})
        invalid_tags = [tag for tag in tags if tag not in VALID_RAG_TAGS]
        planner_state = self._planner_provider_state()

        return {
            "mode": "llm_planner_with_local_curated_retrieval",
            "production_mode": self.production_mode,
            "units_loaded": len(self._units),
            "categories": categories,
            "tags": tags,
            "invalid_tags": invalid_tags,
            "corpus_dir": str(self.corpus_dir),
            "corpus_dir_exists": self.corpus_dir.exists(),
            "corpus_dirs": [str(path) for path in self.corpus_dirs],
            "corpus_dirs_exist": {str(path): path.exists() for path in self.corpus_dirs},
            "loaded_files": list(self._loaded_files),
            "failed_files": list(self._failed_files),
            "using_builtin_fallback": self._using_builtin_fallback,
            "builtin_fallback_enabled": self.use_builtin_fallback,
            "builtin_fallback_allowed_in_production": self.allow_builtin_fallback_in_production,
            "llm_planning_enabled": self.enable_llm_planning,
            "llm_service_available": self.llm_service is not None,
            "llm_planner_provider_state": planner_state,
            "llm_planner_can_call_llm": planner_state["planner_can_call_llm"],
            "offline_llm_planner_allowed": self.allow_offline_llm_planner,
            "vector_db_required": False,
            "last_result": None if self._last_result is None else self._last_result.to_public_dict(),
        }

    def _planner_provider_state(self) -> dict[str, bool]:
        if self.llm_service is None:
            return {
                "remote_provider_available": False,
                "offline_available": False,
                "offline_allowed_by_llm_service": False,
                "offline_allowed_for_rag_planner": self.allow_offline_llm_planner,
                "planner_can_call_llm": False,
            }

        try:
            health = self.llm_service.health()
        except Exception:
            return {
                "remote_provider_available": False,
                "offline_available": False,
                "offline_allowed_by_llm_service": False,
                "offline_allowed_for_rag_planner": self.allow_offline_llm_planner,
                "planner_can_call_llm": False,
            }

        remote_available = bool(
            health.get("configured_remote_provider_available", False)
            or health.get("remote_provider_available", False)
        )
        offline_available = bool(health.get("offline_available", False))
        offline_allowed_by_llm_service = bool(health.get("offline_allowed", False))

        planner_can_call_llm = bool(
            remote_available
            or (
                self.allow_offline_llm_planner
                and offline_available
                and offline_allowed_by_llm_service
            )
        )

        return {
            "remote_provider_available": remote_available,
            "offline_available": offline_available,
            "offline_allowed_by_llm_service": offline_allowed_by_llm_service,
            "offline_allowed_for_rag_planner": self.allow_offline_llm_planner,
            "planner_can_call_llm": planner_can_call_llm,
        }

    async def _build_llm_plan(
        self,
        message: str,
        *,
        safety_tags: tuple[str, ...],
        locale: str,
        memory_summary: str | None,
    ) -> tuple[RAGQueryPlan, str]:
        if self.llm_service is None:
            raise RAGError("LLM planner requested without LLM service", code="rag_llm_missing")

        payload = {
            "locale": locale,
            "message": sanitize_text(message, MAX_QUERY_CHARS),
            "safety_tags": list(safety_tags),
            "memory_context": sanitize_text(memory_summary or "", MAX_MEMORY_CONTEXT_CHARS),
            "available_categories": sorted({unit.category for unit in self._units}),
            "available_tags": sorted({tag for unit in self._units for tag in unit.tags})[:120],
            "available_techniques": sorted({unit.technique for unit in self._units})[:120],
        }

        llm_request = build_llm_request(
            request_id="rag_planner",
            system_prompt=RAG_PLANNER_SYSTEM_PROMPT,
            user_message=json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            temperature=0.1,
            max_output_tokens=700,
            metadata={
                "purpose": "rag_retrieval_planning",
                "stores_raw_chat": False,
            },
        )

        result = await self.llm_service.generate_with_trace(llm_request)
        response = result.response
        provider_used = sanitize_text(response.provider_used or "unknown", 80)

        if _clean_provider_name(provider_used) == "offline" and not self.allow_offline_llm_planner:
            raise RAGError(
                "Offline LLM fallback cannot be used for RAG planning",
                code="rag_offline_planner_disabled",
            )

        raw_plan = self._parse_llm_plan_json(response.text)

        return self._plan_from_payload(
            raw_plan,
            fallback_query=message,
            fallback_tags=safety_tags,
            fallback_locale=locale,
            source="llm_planner",
        ), provider_used

    def _build_local_plan(
        self,
        message: str,
        *,
        safety_tags: tuple[str, ...],
        locale: str,
        memory_summary: str | None,
        source: str,
    ) -> RAGQueryPlan:
        expanded_tags = list(safety_tags)
        lowered = message.lower()
        memory_lowered = sanitize_text(memory_summary or "", MAX_MEMORY_CONTEXT_CHARS).lower()
        combined = f"{lowered}\n{memory_lowered}"

        heuristic_map: tuple[tuple[str, tuple[str, ...]], ...] = (
            ("panic", ("panic_grounding", "54321_grounding", "box_breathing", "anxiety")),
            ("panic attack", ("panic_grounding", "54321_grounding", "box_breathing", "anxiety")),
            ("can't breathe", ("panic_grounding", "54321_grounding", "box_breathing")),
            ("cannot breathe", ("panic_grounding", "54321_grounding", "box_breathing")),
            ("heart racing", ("panic_grounding", "box_breathing")),
            ("نوبة هلع", ("panic_grounding", "54321_grounding", "box_breathing")),
            ("مش قادر اتنفس", ("panic_grounding", "54321_grounding", "box_breathing")),
            ("مش قادرة اتنفس", ("panic_grounding", "54321_grounding", "box_breathing")),
            ("anxious", ("anxiety", "box_breathing", "grounding")),
            ("anxiety", ("anxiety", "box_breathing", "grounding")),
            ("قلقان", ("anxiety", "box_breathing", "grounding")),
            ("قلقانة", ("anxiety", "box_breathing", "grounding")),
            ("angry", ("dbt_stop", "anger", "emotion_regulation")),
            ("rage", ("dbt_stop", "anger", "impulse")),
            ("متنرفز", ("dbt_stop", "anger", "emotion_regulation")),
            ("مش قادر امسك نفسي", ("dbt_stop", "urge_surfing", "impulse")),
            ("urge", ("urge_surfing", "delay", "emotion_regulation")),
            ("craving", ("urge_surfing", "delay")),
            ("worthless", ("reframing", "cognitive_support", "self_criticism")),
            ("i failed", ("reframing", "cognitive_support", "self_criticism")),
            ("انا فاشل", ("reframing", "cognitive_support", "self_criticism")),
            ("don't know what i feel", ("emotion_labeling", "reflection", "emotion_regulation")),
            ("confused", ("emotion_labeling", "reflection")),
            ("حاسس بلخبطة", ("emotion_labeling", "reflection")),
        )

        for phrase, tags in heuristic_map:
            if phrase in combined:
                expanded_tags.extend(tags)

        valid_tag_heuristics: tuple[tuple[str, tuple[str, ...]], ...] = (
            ("panic", ("panic_grounding", "grounding_54321", "box_breathing", "anxiety")),
            ("panic attack", ("panic_grounding", "grounding_54321", "box_breathing", "anxiety")),
            ("can't breathe", ("panic_grounding", "grounding_54321", "box_breathing")),
            ("cannot breathe", ("panic_grounding", "grounding_54321", "box_breathing")),
            ("نوبة هلع", ("panic_grounding", "grounding_54321", "box_breathing")),
            ("مش قادر اتنفس", ("panic_grounding", "grounding_54321", "box_breathing")),
            ("مش قادرة اتنفس", ("panic_grounding", "grounding_54321", "box_breathing")),
            ("angry", ("dbt_stop", "anger", "impulse")),
            ("rage", ("dbt_stop", "anger", "impulse")),
            ("furious", ("dbt_stop", "anger", "impulse")),
            ("متنرفز", ("dbt_stop", "anger")),
            ("مش قادر امسك نفسي", ("dbt_stop", "impulse")),
            ("overthinking", ("cognitive_reframe", "emotion_labeling")),
            ("can't stop thinking", ("cognitive_reframe", "emotion_labeling")),
            ("catastrophizing", ("cognitive_reframe", "anxiety")),
            ("worthless", ("cognitive_reframe", "emotion_labeling")),
            ("i failed", ("cognitive_reframe", "study_stress")),
            ("انا فاشل", ("cognitive_reframe", "emotion_labeling")),
            ("exam", ("study_stress", "exam_anxiety")),
            ("study", ("study_stress",)),
            ("assignment", ("study_stress",)),
            ("boundary", ("relationship", "relationship_distress", "safety")),
            ("relationship", ("relationship", "relationship_distress")),
            ("partner", ("relationship", "relationship_distress")),
            ("husband", ("relationship", "relationship_distress", "safety")),
            ("wife", ("relationship", "relationship_distress", "safety")),
            ("مش عارف اكمل", ("relationship", "relationship_distress")),
            ("بيقلل مني", ("relationship", "relationship_distress")),
            ("بيهددني", ("relationship", "relationship_distress", "safety", "abuse_or_violence")),
            ("خايفة منه", ("relationship", "relationship_distress", "safety", "abuse_or_violence")),
        )

        for phrase, tags in valid_tag_heuristics:
            if phrase in combined:
                expanded_tags.extend(tags)

        rewritten_query_parts = [message]
        if safety_tags:
            rewritten_query_parts.append(" ".join(safety_tags))
        if memory_summary:
            rewritten_query_parts.append(sanitize_text(memory_summary, 500))

        return RAGQueryPlan(
            rewritten_query=safe_truncate(" ".join(part for part in rewritten_query_parts if part), MAX_QUERY_CHARS),
            tags=tuple(_clean_terms(expanded_tags)),
            categories=(),
            techniques=(),
            contraindications=(),
            locale=locale,
            source=source,
        )

    def _result_from_plan(
        self,
        plan: RAGQueryPlan,
        *,
        max_results: int,
        used_llm_plan: bool,
        fallback_used: bool,
        planner_provider: str | None = None,
        error_code: str | None = None,
    ) -> RAGRetrievalResult:
        tags = _clean_terms(list(plan.tags) + list(plan.categories) + list(plan.techniques))
        query = " ".join(
            part
            for part in (
                plan.rewritten_query,
                " ".join(plan.categories),
                " ".join(plan.techniques),
            )
            if part
        )

        matches = self.retrieve(
            query,
            tags=tags,
            max_results=max_results,
            min_score=0.05,
        )

        return RAGRetrievalResult(
            matches=tuple(matches),
            prompt_grounding=tuple(match.to_prompt_dict() for match in matches),
            references=tuple(match.to_reference() for match in matches),
            plan=plan,
            used_llm_plan=used_llm_plan,
            fallback_used=fallback_used,
            planner_provider=planner_provider,
            error_code=error_code,
        )

    def _parse_llm_plan_json(self, text: str) -> dict[str, Any]:
        cleaned = sanitize_text(text, MAX_LLM_PLAN_CHARS).strip()
        cleaned = _strip_code_fence(cleaned)
        json_text = _extract_json_object(cleaned)

        try:
            payload = json.loads(json_text)
        except json.JSONDecodeError as exc:
            raise RAGError("LLM RAG plan JSON failed to parse", code="rag_llm_invalid_json") from exc

        if not isinstance(payload, dict):
            raise RAGError("LLM RAG plan must be a JSON object", code="rag_llm_invalid_shape")

        return payload

    def _plan_from_payload(
        self,
        payload: dict[str, Any],
        *,
        fallback_query: str,
        fallback_tags: tuple[str, ...],
        fallback_locale: str,
        source: str,
    ) -> RAGQueryPlan:
        rewritten_query = sanitize_text(str(payload.get("rewritten_query") or fallback_query), MAX_QUERY_CHARS)
        tags = _clean_terms(list(fallback_tags) + _coerce_list(payload.get("tags", [])))
        categories = _clean_terms(payload.get("categories", []))
        techniques = _clean_terms(payload.get("techniques", []))
        contraindications = _clean_terms(payload.get("contraindications", []))
        locale = normalize_locale(str(payload.get("locale") or fallback_locale))

        if not rewritten_query and not tags and not categories and not techniques:
            raise RAGError("LLM RAG plan is empty", code="rag_llm_empty_plan")

        return RAGQueryPlan(
            rewritten_query=rewritten_query,
            tags=tags,
            categories=categories,
            techniques=techniques,
            contraindications=contraindications,
            locale=locale,
            source=source,
        )

    def _load_yaml_units(self, path: Path) -> list[GroundingUnit]:
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
        except yaml.YAMLError as exc:
            raise RAGError(
                "RAG corpus YAML failed to parse",
                code="rag_yaml_parse_error",
                details={"path": str(path)},
            ) from exc

        if data is None:
            return []

        raw_units: list[Any]

        if isinstance(data, dict) and "units" in data:
            raw_units = data["units"]
        elif isinstance(data, list):
            raw_units = data
        elif isinstance(data, dict):
            raw_units = [data]
        else:
            raise RAGError(
                "RAG corpus file must contain a mapping, list, or units list",
                code="invalid_rag_corpus",
                details={"path": str(path)},
            )

        if not isinstance(raw_units, list):
            raise RAGError(
                "RAG corpus units must be a list",
                code="invalid_rag_units",
                details={"path": str(path)},
            )

        units: list[GroundingUnit] = []

        for index, raw_unit in enumerate(raw_units):
            if not isinstance(raw_unit, dict):
                raise RAGError(
                    "RAG corpus unit must be a mapping",
                    code="invalid_rag_unit",
                    details={"path": str(path), "index": index},
                )

            units.append(self._parse_unit(raw_unit, source=path.name))

        return units

    def _parse_unit(self, raw: dict[str, Any], *, source: str) -> GroundingUnit:
        grounding_id = _clean_required(raw.get("id") or raw.get("grounding_id"), "id", 120)
        category = _clean_required(raw.get("category"), "category", 80)
        technique = _clean_required(raw.get("technique"), "technique", 120)

        trigger_terms = _clean_terms(
            raw.get("trigger_terms")
            or raw.get("triggers")
            or raw.get("keywords")
            or ()
        )

        instructions = _clean_list(
            raw.get("instructions") or (),
            max_items=20,
            max_chars=MAX_INSTRUCTION_CHARS,
        )

        contraindications = _clean_list(
            raw.get("contraindications") or (),
            max_items=20,
            max_chars=MAX_INSTRUCTION_CHARS,
        )

        response_style = _clean_list(
            raw.get("response_style") or (),
            max_items=MAX_RESPONSE_STYLE_ITEMS,
            max_chars=120,
        )

        tags = _clean_terms(
            raw.get("tags")
            or raw.get("rag_tags")
            or (category, technique, grounding_id)
        )

        if not trigger_terms and not tags:
            raise RAGError(
                "RAG unit must define trigger_terms or tags",
                code="invalid_rag_unit_terms",
                details={"grounding_id": grounding_id},
            )

        if not instructions:
            raise RAGError(
                "RAG unit must define at least one instruction",
                code="invalid_rag_unit_instructions",
                details={"grounding_id": grounding_id},
            )

        return GroundingUnit(
            grounding_id=grounding_id,
            category=category,
            technique=technique,
            trigger_terms=tuple(trigger_terms),
            instructions=tuple(instructions),
            contraindications=tuple(contraindications),
            response_style=tuple(response_style),
            tags=tuple(tags),
            source=source,
        )

    @staticmethod
    def _assert_unique_ids(units: list[GroundingUnit]) -> None:
        seen: set[str] = set()

        for unit in units:
            if unit.grounding_id in seen:
                raise RAGError(
                    "Duplicate RAG grounding id",
                    code="duplicate_rag_grounding_id",
                    details={"grounding_id": unit.grounding_id},
                )

            seen.add(unit.grounding_id)


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


def _unique_paths(paths: tuple[Path, ...]) -> tuple[Path, ...]:
    seen: set[str] = set()
    output: list[Path] = []

    for path in paths:
        resolved = path.resolve()
        key = str(resolved).lower()

        if key in seen:
            continue

        seen.add(key)
        output.append(resolved)

    return tuple(output)


def _iter_yaml_files(directory: Path) -> tuple[Path, ...]:
    return tuple(sorted({*directory.glob("*.yaml"), *directory.glob("*.yml")}))


def _score_unit(
    unit: GroundingUnit,
    *,
    query_lower: str,
    query_tokens: set[str],
    requested_tags: tuple[str, ...],
) -> tuple[float, list[str]]:
    score = 0.0
    matched_terms: list[str] = []

    searchable_terms = tuple(
        _unique_ordered(
            list(unit.trigger_terms)
            + list(unit.tags)
            + [unit.category, unit.technique, unit.grounding_id]
        )
    )

    for tag in requested_tags:
        if _term_matches_unit(tag, unit):
            score += 0.46
            matched_terms.append(tag)

    for term in searchable_terms:
        term_lower = term.lower()
        term_tokens = _tokenize(term_lower)

        if not term_lower:
            continue

        if query_lower and term_lower in query_lower:
            score += 0.36 if " " in term_lower else 0.2
            matched_terms.append(term)
            continue

        if query_tokens and term_tokens:
            overlap = len(query_tokens.intersection(term_tokens))
            if overlap:
                score += min(0.24, 0.08 * overlap)
                matched_terms.append(term)

    category_lower = unit.category.lower()
    technique_lower = unit.technique.lower()

    if category_lower and category_lower in query_lower:
        score += 0.16

    if technique_lower and technique_lower in query_lower:
        score += 0.16

    if matched_terms:
        score = score / math.sqrt(max(1.0, min(len(searchable_terms), 16) / 4))

    return min(score, 1.0), list(_unique_ordered(matched_terms))


def _term_matches_unit(term: str, unit: GroundingUnit) -> bool:
    normalized = term.lower()
    candidates = (
        list(unit.tags)
        + list(unit.trigger_terms)
        + [unit.category, unit.technique, unit.grounding_id]
    )

    return any(normalized == candidate.lower() for candidate in candidates)


def _tokenize(text: str) -> set[str]:
    return {
        token.lower()
        for token in _WORD_RE.findall(text)
        if len(token.strip()) >= 2
    }


def _clean_required(value: Any, field_name: str, max_chars: int) -> str:
    cleaned = sanitize_text(str(value or ""), max_chars)

    if not cleaned:
        raise RAGError(
            "RAG unit required field is missing",
            code="invalid_rag_unit_required_field",
            details={"field": field_name},
        )

    return cleaned


def _clean_terms(value: Any) -> tuple[str, ...]:
    return tuple(
        _unique_ordered(
            _clean_list(value, max_items=80, max_chars=MAX_TRIGGER_CHARS)
        )
    )


def _clean_list(value: Any, *, max_items: int, max_chars: int) -> list[str]:
    if value is None:
        return []

    if isinstance(value, str):
        raw_items = [value]
    elif isinstance(value, (list, tuple, set, frozenset)):
        raw_items = list(value)
    else:
        raw_items = [value]

    cleaned: list[str] = []

    for item in raw_items[:max_items]:
        text = sanitize_text(str(item or ""), max_chars)
        text = safe_truncate(text, max_chars)

        if text:
            cleaned.append(text)

    return cleaned


def _unique_ordered(values: list[str] | tuple[str, ...]) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []

    for value in values:
        original = sanitize_text(str(value), MAX_TRIGGER_CHARS)
        key = original.lower()

        if not key or key in seen:
            continue

        seen.add(key)
        output.append(original)

    return output


def _coerce_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, (list, tuple, set, frozenset)):
        return [str(item) for item in value]
    return [str(value)]


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
        raise RAGError("LLM RAG plan did not contain JSON", code="rag_llm_invalid_json")

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

    raise RAGError("LLM RAG plan JSON object was incomplete", code="rag_llm_invalid_json")


def _builtin_units() -> tuple[GroundingUnit, ...]:
    return (
        GroundingUnit(
            grounding_id="grounding_54321",
            category="anxiety",
            technique="5-4-3-2-1 grounding",
            trigger_terms=(
                "panic",
                "panic attack",
                "anxiety attack",
                "spiraling",
                "can't breathe",
                "cannot breathe",
                "مش قادر اتنفس",
                "مش قادرة اتنفس",
                "نوبة هلع",
            ),
            instructions=(
                "Ask the user to name 5 things they can see.",
                "Ask for 4 things they can physically feel.",
                "Continue with 3 sounds, 2 smells, and 1 taste if the user can engage.",
                "Keep the pace slow and concrete.",
            ),
            contraindications=(
                "Do not claim this treats or cures panic disorder.",
                "Do not tell the user symptoms are harmless with certainty.",
            ),
            response_style=("calm", "short", "concrete", "step-by-step"),
            tags=("panic_grounding", "54321_grounding", "anxiety", "grounding"),
        ),
        GroundingUnit(
            grounding_id="box_breathing_basic",
            category="anxiety",
            technique="box breathing",
            trigger_terms=(
                "anxious",
                "overwhelmed",
                "heart racing",
                "breathing fast",
                "قلقان",
                "قلقانة",
                "قلبي بيدق بسرعة",
            ),
            instructions=(
                "Invite a 4-second inhale, 4-second hold, 4-second exhale, and 4-second hold.",
                "Use only one or two cycles at first.",
                "Tell the user to stop if breathing control feels uncomfortable.",
            ),
            contraindications=(
                "Do not force breath holds if the user feels unsafe or physically uncomfortable.",
                "Do not present breathing as medical treatment.",
            ),
            response_style=("gentle", "brief", "non-forceful"),
            tags=("box_breathing", "anxiety", "breathing"),
        ),
        GroundingUnit(
            grounding_id="dbt_stop_skill",
            category="emotion_regulation",
            technique="DBT STOP skill",
            trigger_terms=(
                "angry",
                "impulsive",
                "about to text",
                "about to explode",
                "rage",
                "مش قادر امسك نفسي",
                "متنرفز",
                "هتصرف غلط",
            ),
            instructions=(
                "S: Stop before acting.",
                "T: Take a step back physically or digitally.",
                "O: Observe body sensations, emotion, and urge.",
                "P: Proceed with one action that reduces damage.",
            ),
            contraindications=(
                "Do not use this to minimize immediate danger.",
                "If violence risk is present, prioritize distance and local emergency support.",
            ),
            response_style=("firm", "short", "action-oriented"),
            tags=("dbt_stop", "emotion_regulation", "anger", "impulse"),
        ),
        GroundingUnit(
            grounding_id="urge_surfing_basic",
            category="emotion_regulation",
            technique="urge surfing",
            trigger_terms=(
                "urge",
                "craving",
                "I want to do it",
                "I can't resist",
                "مش قادر اقاوم",
                "رغبة قوية",
            ),
            instructions=(
                "Frame the urge as a wave that rises, peaks, and falls.",
                "Ask the user to delay action for 10 minutes.",
                "Have the user describe where the urge sits in the body.",
                "Encourage one safe competing action during the delay.",
            ),
            contraindications=(
                "Do not use as the only response when immediate self-harm or violence intent is present.",
            ),
            response_style=("grounded", "practical", "time-bounded"),
            tags=("urge_surfing", "emotion_regulation", "delay"),
        ),
        GroundingUnit(
            grounding_id="cognitive_reframing_light",
            category="cognitive_support",
            technique="light cognitive reframing",
            trigger_terms=(
                "I am worthless",
                "I failed",
                "everyone hates me",
                "catastrophizing",
                "أنا فاشل",
                "انا فاشل",
                "محدش بيحبني",
            ),
            instructions=(
                "Reflect the thought without validating it as fact.",
                "Ask for one piece of evidence for and one against the thought.",
                "Offer a more balanced sentence using 'right now' instead of permanent labels.",
            ),
            contraindications=(
                "Do not argue aggressively with the user's feeling.",
                "Do not claim the thought is false with certainty.",
            ),
            response_style=("balanced", "respectful", "non-argumentative"),
            tags=("reframing", "cognitive_support", "self_criticism"),
        ),
        GroundingUnit(
            grounding_id="emotion_labeling_basic",
            category="emotion_regulation",
            technique="emotion labeling",
            trigger_terms=(
                "I don't know what I feel",
                "confused",
                "numb",
                "mixed feelings",
                "مش فاهم حاسس بإيه",
                "حاسس بلخبطة",
                "متلخبط",
            ),
            instructions=(
                "Ask the user to choose up to three emotion words.",
                "Ask for body location: chest, throat, stomach, head, shoulders, or elsewhere.",
                "Ask what the emotion is trying to protect or signal.",
            ),
            contraindications=(
                "Do not over-interpret the emotion.",
                "Do not infer trauma or diagnosis.",
            ),
            response_style=("curious", "simple", "low-pressure"),
            tags=("emotion_labeling", "emotion_regulation", "reflection"),
        ),
    )
