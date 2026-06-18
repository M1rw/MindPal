# backend/services/safety_service.py

from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from re import Pattern
from typing import Any

import yaml

from backend.core.config import Settings, get_settings
from backend.core.errors import SafetyError
from backend.core.security import Locale, normalize_locale, sanitize_text
from backend.core.settings_helpers import is_production, setting_bool, setting_value
from backend.models.safety import (
    CrisisResponseTemplate,
    SafetyAction,
    SafetyDecision,
    SafetyEvent,
    SafetyLevel,
    SafetyMatchedRule,
    SafetySource,
)
from backend.services.llm_service import LLMService, build_llm_request

logger = logging.getLogger(__name__)


MAX_CLASSIFICATION_TEXT_CHARS = 8_000
MAX_MEMORY_CONTEXT_CHARS = 1_200
MAX_LLM_JSON_CHARS = 6_000
SUPPORTED_PATTERN_LOCALES: tuple[Locale, ...] = ("en", "ar")

SAFETY_CLASSIFIER_SYSTEM_PROMPT = """
You are MindPal's second-stage safety classifier.

You classify sanitized user text after deterministic local crisis patterns already ran.

Rules:
- Return JSON only.
- Do not respond to the user.
- Do not provide advice.
- Do not include raw user text.
- Do not diagnose.
- Do not infer medical conditions.
- If there is clear immediate or near-term self-harm intent, classify self_harm_imminent.
- If there is passive death wish without immediate plan/timing/means, classify self_harm_ambiguous.
- If the user is distressed but not unsafe, classify supportive.
- If the user may be in danger from someone else or may harm someone else, classify abuse_or_violence.
- If the user is hostile but no safety emergency is present, classify toxicity.
- Otherwise classify safe.

Return exactly:
{
  "level": "safe|supportive|self_harm_ambiguous|self_harm_imminent|abuse_or_violence|toxicity",
  "confidence": 0.0,
  "user_visible_category": "short_category",
  "rationale": "short sanitized rationale",
  "matched_rules": ["short_internal_rule"],
  "should_log": false
}
""".strip()


_SAFETY_RANK: dict[SafetyLevel, int] = {
    SafetyLevel.SAFE: 0,
    SafetyLevel.SUPPORTIVE: 1,
    SafetyLevel.TOXICITY: 2,
    SafetyLevel.SELF_HARM_AMBIGUOUS: 3,
    SafetyLevel.ABUSE_OR_VIOLENCE: 4,
    SafetyLevel.SELF_HARM_IMMINENT: 5,
}


@dataclass(frozen=True, slots=True)
class CompiledSafetyRule:
    rule_id: str
    level: SafetyLevel
    action: SafetyAction
    bypass_llm: bool
    response_template_id: str | None
    should_log: bool
    user_visible_category: str
    confidence: float
    priority: int
    match_mode: str
    source_locale: Locale
    patterns: tuple[Pattern[str], ...]
    pattern_groups: dict[str, tuple[Pattern[str], ...]]
    rag_tags: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class CompiledExclusionRule:
    rule_id: str
    description: str
    source_locale: Locale
    patterns: tuple[Pattern[str], ...]


@dataclass(frozen=True, slots=True)
class SafetyRuleMatch:
    rule: CompiledSafetyRule
    confidence: float
    matched_pattern_refs: tuple[str, ...]
    exclusion_context: bool = False

    @property
    def priority(self) -> int:
        return self.rule.priority


@dataclass(frozen=True, slots=True)
class SafetyClassifierMeta:
    mode: str
    used_llm: bool
    fallback_used: bool
    provider_used: str | None = None
    error_code: str | None = None


class SafetyService:
    """
    Safety classifier.

    Hard contract:
    - Local deterministic rules always run before any LLM.
    - self_harm_imminent from local rules must return immediately.
    - self_harm_imminent must bypass LLM response generation.
    - Deterministic crisis templates must not be rewritten by LLM.
    - LLM ambiguity classification can upgrade risk, but cannot weaken local high-risk decisions.
    """

    def __init__(
        self,
        safety_dir: Path | None = None,
        *,
        settings: Settings | None = None,
        llm_service: LLMService | None = None,
        enable_llm_ambiguity_classifier: bool | None = None,
        allow_offline_llm_classifier: bool | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.production_mode = is_production(self.settings)

        self.safety_dir = safety_dir or Path(__file__).resolve().parents[1] / "safety"
        self.llm_service = llm_service

        self.enable_llm_ambiguity_classifier = (
            setting_bool(
                self.settings,
                "ENABLE_LLM_SAFETY_CLASSIFIER",
                default=True,
            )
            if enable_llm_ambiguity_classifier is None
            else bool(enable_llm_ambiguity_classifier)
        )

        self.allow_offline_llm_classifier = (
            setting_bool(
                self.settings,
                "ALLOW_OFFLINE_LLM_SAFETY_CLASSIFIER",
                default=False,
            )
            if allow_offline_llm_classifier is None
            else bool(allow_offline_llm_classifier)
        )

        self._rules: list[CompiledSafetyRule] = []
        self._exclusion_rules: list[CompiledExclusionRule] = []
        self._templates: dict[str, CrisisResponseTemplate] = {}
        self._fallback_templates: dict[Locale, str] = {}

        self.last_meta: SafetyClassifierMeta | None = None

        self.reload()

    def reload(self) -> None:
        rules: list[CompiledSafetyRule] = []
        exclusions: list[CompiledExclusionRule] = []

        for locale in SUPPORTED_PATTERN_LOCALES:
            loaded_rules, loaded_exclusions = self._load_pattern_file(locale)
            rules.extend(loaded_rules)
            exclusions.extend(loaded_exclusions)

        templates, fallbacks = self._load_response_templates()

        self._rules = sorted(rules, key=lambda item: (item.priority, item.confidence), reverse=True)
        self._exclusion_rules = exclusions
        self._templates = templates
        self._fallback_templates = fallbacks

    def classify_input(self, text: str, locale: str | None = "auto") -> SafetyDecision:
        """
        Local deterministic classifier.

        This is sync and must remain available without external providers.
        """
        cleaned = sanitize_text(text, MAX_CLASSIFICATION_TEXT_CHARS)
        resolved_locale = normalize_locale(locale)

        if not cleaned:
            self.last_meta = SafetyClassifierMeta(
                mode="local_empty_safe",
                used_llm=False,
                fallback_used=False,
            )
            return SafetyDecision.safe()

        matches = self._find_matches(cleaned, resolved_locale)

        if not matches:
            self.last_meta = SafetyClassifierMeta(
                mode="local_safe",
                used_llm=False,
                fallback_used=False,
            )
            return SafetyDecision.safe()

        decision = self._decision_from_match(matches)

        self._enforce_non_bypassable_contract(decision)

        self.last_meta = SafetyClassifierMeta(
            mode="local_deterministic",
            used_llm=False,
            fallback_used=False,
        )

        return decision

    async def classify_input_with_context(
        self,
        text: str,
        *,
        locale: str | None = "auto",
        memory_summary: str | None = None,
        channel: str | None = None,
    ) -> SafetyDecision:
        """
        Upgraded classifier.

        Local deterministic rules run first. If they detect imminent self-harm,
        this method returns immediately and does not call the LLM classifier.

        For non-imminent cases, the optional LLM classifier can add nuance for
        language, slang, context, and ambiguous distress.
        """
        local_decision = self.classify_input(text, locale)

        if local_decision.level == SafetyLevel.SELF_HARM_IMMINENT:
            self.last_meta = SafetyClassifierMeta(
                mode="local_imminent_bypass",
                used_llm=False,
                fallback_used=False,
            )
            return local_decision

        if not self.enable_llm_ambiguity_classifier:
            self.last_meta = SafetyClassifierMeta(
                mode="local_only",
                used_llm=False,
                fallback_used=True,
                error_code="llm_classifier_disabled",
            )
            return local_decision

        if self.llm_service is None:
            self.last_meta = SafetyClassifierMeta(
                mode="local_only",
                used_llm=False,
                fallback_used=True,
                error_code="llm_classifier_missing",
            )
            return local_decision

        provider_state = self._llm_classifier_provider_state()

        if not provider_state["classifier_can_call_llm"]:
            self.last_meta = SafetyClassifierMeta(
                mode="local_only",
                used_llm=False,
                fallback_used=True,
                error_code="llm_classifier_provider_unavailable",
            )
            return local_decision

        try:
            llm_decision, provider_used = await self._classify_with_llm(
                text,
                locale=locale,
                memory_summary=memory_summary,
                channel=channel,
                local_decision=local_decision,
            )

            final_decision = self._merge_local_and_llm_decisions(
                local_decision,
                llm_decision,
            )

            self._enforce_non_bypassable_contract(final_decision)

            self.last_meta = SafetyClassifierMeta(
                mode="llm_ambiguity_classifier",
                used_llm=True,
                fallback_used=False,
                provider_used=provider_used,
            )

            return final_decision

        except Exception as exc:
            self.last_meta = SafetyClassifierMeta(
                mode="local_fallback_after_llm_failure",
                used_llm=True,
                fallback_used=True,
                error_code=exc.__class__.__name__,
            )
            return local_decision

    def build_safety_event(
        self,
        *,
        request_id: str,
        user_id_hash: str,
        decision: SafetyDecision,
        locale: str | None = "auto",
        source: SafetySource = SafetySource.LOCAL_REGEX,
    ) -> SafetyEvent:
        resolved_locale = normalize_locale(locale)

        rule_matches = [
            SafetyMatchedRule(
                rule_id=rule_id,
                source=source,
                language=resolved_locale,
                confidence=decision.confidence,
            )
            for rule_id in decision.matched_rules
        ]

        return SafetyEvent(
            request_id=request_id,
            user_id_hash=user_id_hash,
            decision=decision,
            source=source,
            locale=resolved_locale,
            rule_matches=rule_matches,
        )

    def get_crisis_response_template(
        self,
        template_id: str | None,
        locale: str | None = "auto",
    ) -> CrisisResponseTemplate:
        resolved_locale = normalize_locale(locale)

        if template_id and template_id in self._templates:
            return self._templates[template_id]

        fallback_id = self._fallback_templates.get(resolved_locale)

        if fallback_id and fallback_id in self._templates:
            return self._templates[fallback_id]

        default_fallback_id = self._fallback_templates.get("auto") or self._fallback_templates.get("en")

        if default_fallback_id and default_fallback_id in self._templates:
            return self._templates[default_fallback_id]

        raise SafetyError(
            "No deterministic crisis response template available",
            code="crisis_template_missing",
            details={"template_id": template_id or ""},
        )

    def render_deterministic_response(
        self,
        decision: SafetyDecision,
        locale: str | None = "auto",
    ) -> str:
        if not decision.bypass_llm:
            raise SafetyError(
                "Cannot render deterministic crisis response for non-bypass decision",
                code="deterministic_response_not_required",
                details={"level": decision.level.value},
            )

        self._enforce_non_bypassable_contract(decision)
        template = self.get_crisis_response_template(decision.response_template_id, locale)
        return template.body

    def rag_tags_for_decision(self, decision: SafetyDecision) -> list[str]:
        tags: list[str] = []
        seen: set[str] = set()

        matched_ids = set(decision.matched_rules)

        for rule in self._rules:
            if rule.rule_id not in matched_ids:
                continue

            for tag in rule.rag_tags:
                if tag not in seen:
                    seen.add(tag)
                    tags.append(tag)

        if decision.level == SafetyLevel.SELF_HARM_AMBIGUOUS:
            for tag in ("grounding", "emotion_regulation"):
                if tag not in seen:
                    seen.add(tag)
                    tags.append(tag)

        if decision.level == SafetyLevel.ABUSE_OR_VIOLENCE:
            for tag in ("dbt_stop", "emotion_regulation"):
                if tag not in seen:
                    seen.add(tag)
                    tags.append(tag)

        return tags

    def health(self) -> dict[str, Any]:
        provider_state = self._llm_classifier_provider_state()

        return {
            "mode": "deterministic_crisis_first_with_optional_llm_ambiguity_classifier",
            "production_mode": self.production_mode,
            "rules_loaded": len(self._rules),
            "exclusion_rules_loaded": len(self._exclusion_rules),
            "templates_loaded": len(self._templates),
            "fallback_templates_loaded": len(self._fallback_templates),
            "locales": list(SUPPORTED_PATTERN_LOCALES),
            "llm_ambiguity_classifier_enabled": self.enable_llm_ambiguity_classifier,
            "llm_service_available": self.llm_service is not None,
            "llm_ambiguity_classifier_provider_state": provider_state,
            "llm_ambiguity_classifier_can_call_llm": provider_state["classifier_can_call_llm"],
            "offline_llm_classifier_allowed": self.allow_offline_llm_classifier,
            "imminent_self_harm_bypasses_llm": True,
            "deterministic_crisis_templates_required": True,
            "last_meta": None if self.last_meta is None else asdict(self.last_meta),
        }

    def _llm_classifier_provider_state(self) -> dict[str, bool]:
        if self.llm_service is None:
            return {
                "remote_provider_available": False,
                "offline_available": False,
                "offline_allowed_by_llm_service": False,
                "offline_allowed_for_safety_classifier": self.allow_offline_llm_classifier,
                "classifier_can_call_llm": False,
            }

        try:
            health = self.llm_service.health()
        except Exception:
            logger.warning("LLM service health check failed for safety classifier", exc_info=True)
            return {
                "remote_provider_available": False,
                "offline_available": False,
                "offline_allowed_by_llm_service": False,
                "offline_allowed_for_safety_classifier": self.allow_offline_llm_classifier,
                "classifier_can_call_llm": False,
            }

        remote_available = bool(
            health.get("configured_remote_provider_available", False)
            or health.get("remote_provider_available", False)
        )
        offline_available = bool(health.get("offline_available", False))
        offline_allowed_by_llm_service = bool(health.get("offline_allowed", False))

        classifier_can_call_llm = bool(
            remote_available
            or (
                self.allow_offline_llm_classifier
                and offline_available
                and offline_allowed_by_llm_service
            )
        )

        return {
            "remote_provider_available": remote_available,
            "offline_available": offline_available,
            "offline_allowed_by_llm_service": offline_allowed_by_llm_service,
            "offline_allowed_for_safety_classifier": self.allow_offline_llm_classifier,
            "classifier_can_call_llm": classifier_can_call_llm,
        }

    async def _classify_with_llm(
        self,
        text: str,
        *,
        locale: str | None,
        memory_summary: str | None,
        channel: str | None,
        local_decision: SafetyDecision,
    ) -> tuple[SafetyDecision, str]:
        if self.llm_service is None:
            raise SafetyError(
                "LLM ambiguity classifier requested without LLM service",
                code="safety_llm_missing",
            )

        resolved_locale = normalize_locale(locale)

        payload = {
            "locale": resolved_locale,
            "channel": sanitize_text(channel or "unknown", 80),
            "sanitized_user_text": sanitize_text(text, MAX_CLASSIFICATION_TEXT_CHARS),
            "sanitized_memory_context": sanitize_text(memory_summary or "", MAX_MEMORY_CONTEXT_CHARS),
            "local_decision": local_decision.to_public_dict(),
            "local_action": local_decision.action.value,
            "instruction": "Classify risk only. Do not respond to the user.",
        }

        request = build_llm_request(
            request_id="safety_ambiguity_classifier",
            system_prompt=SAFETY_CLASSIFIER_SYSTEM_PROMPT,
            user_message=json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            temperature=0.0,
            max_output_tokens=500,
            metadata={
                "purpose": "safety_ambiguity_classification",
                "deterministic_crisis_scan_already_ran": True,
            },
        )

        result = await self.llm_service.generate_with_trace(request)
        response = result.response
        provider_used = sanitize_text(response.provider_used or "unknown", 80)

        if _clean_provider_name(provider_used) == "offline" and not self.allow_offline_llm_classifier:
            raise SafetyError(
                "Offline LLM fallback cannot be used for safety ambiguity classification",
                code="safety_llm_offline_classifier_disabled",
            )

        payload = self._parse_llm_json(response.text)

        return self._decision_from_llm_payload(
            payload,
            locale=resolved_locale,
        ), provider_used

    def _decision_from_llm_payload(
        self,
        payload: dict[str, Any],
        *,
        locale: Locale,
    ) -> SafetyDecision:
        level_raw = sanitize_text(str(payload.get("level", "safe")), 80)

        try:
            level = SafetyLevel(level_raw)
        except ValueError as exc:
            raise SafetyError(
                "LLM safety classifier returned invalid level",
                code="safety_llm_invalid_level",
                details={"level": level_raw},
            ) from exc

        confidence = _bounded_float(payload.get("confidence", 0.5), default=0.5)
        category = sanitize_text(
            str(payload.get("user_visible_category") or _default_category_for_level(level)),
            80,
        )
        rationale = sanitize_text(str(payload.get("rationale") or "llm safety classifier"), 300)
        matched_rules = _clean_rule_ids(payload.get("matched_rules", []))
        matched_rules = ["llm_ambiguity_classifier", *matched_rules]

        should_log = bool(payload.get("should_log", False))

        if level == SafetyLevel.SELF_HARM_IMMINENT:
            return SafetyDecision(
                level=SafetyLevel.SELF_HARM_IMMINENT,
                bypass_llm=True,
                response_template_id=_imminent_template_for_locale(locale),
                matched_rules=matched_rules,
                should_log=True,
                user_visible_category="immediate_safety",
                action=SafetyAction.DETERMINISTIC_RESPONSE,
                confidence=max(confidence, 0.8),
                rationale=rationale,
            )

        if level == SafetyLevel.SAFE:
            return SafetyDecision.safe()

        action = SafetyAction.CONTINUE_TO_LLM

        if level in {
            SafetyLevel.SELF_HARM_AMBIGUOUS,
            SafetyLevel.ABUSE_OR_VIOLENCE,
            SafetyLevel.TOXICITY,
        }:
            action = SafetyAction.DEESCALATE

        return SafetyDecision(
            level=level,
            bypass_llm=False,
            response_template_id=None,
            matched_rules=matched_rules,
            should_log=should_log or level in {SafetyLevel.SELF_HARM_AMBIGUOUS, SafetyLevel.ABUSE_OR_VIOLENCE},
            user_visible_category=category or _default_category_for_level(level),
            action=action,
            confidence=confidence,
            rationale=rationale,
        )

    def _merge_local_and_llm_decisions(
        self,
        local_decision: SafetyDecision,
        llm_decision: SafetyDecision,
    ) -> SafetyDecision:
        if llm_decision.level == SafetyLevel.SELF_HARM_IMMINENT:
            return llm_decision

        if _SAFETY_RANK[llm_decision.level] > _SAFETY_RANK[local_decision.level]:
            return llm_decision

        if _SAFETY_RANK[llm_decision.level] == _SAFETY_RANK[local_decision.level]:
            merged_rules = _unique_rule_ids(
                list(local_decision.matched_rules) + list(llm_decision.matched_rules)
            )

            return SafetyDecision(
                level=local_decision.level,
                bypass_llm=local_decision.bypass_llm,
                response_template_id=local_decision.response_template_id,
                matched_rules=merged_rules,
                should_log=local_decision.should_log or llm_decision.should_log,
                user_visible_category=local_decision.user_visible_category or llm_decision.user_visible_category,
                action=local_decision.action,
                confidence=max(local_decision.confidence, llm_decision.confidence),
                rationale=local_decision.rationale or llm_decision.rationale,
            )

        return local_decision

    def _parse_llm_json(self, text: str) -> dict[str, Any]:
        cleaned = sanitize_text(text, MAX_LLM_JSON_CHARS).strip()
        cleaned = _strip_code_fence(cleaned)
        json_text = _extract_json_object(cleaned)

        try:
            payload = json.loads(json_text)
        except json.JSONDecodeError as exc:
            raise SafetyError(
                "LLM safety classifier JSON failed to parse",
                code="safety_llm_invalid_json",
            ) from exc

        if not isinstance(payload, dict):
            raise SafetyError(
                "LLM safety classifier must return a JSON object",
                code="safety_llm_invalid_shape",
            )

        return payload

    def _decision_from_match(self, matches: list[SafetyRuleMatch]) -> SafetyDecision:
        top_match = matches[0]
        matched_rule_ids = self._collect_matched_rule_ids(matches, top_match.rule.level)

        confidence = top_match.confidence
        rationale = "matched local deterministic safety rule"

        if top_match.exclusion_context and top_match.rule.level != SafetyLevel.SELF_HARM_IMMINENT:
            confidence = round(max(0.0, confidence * 0.6), 3)
            rationale = "matched local safety rule with reported/fictional context signal"

        decision = SafetyDecision(
            level=top_match.rule.level,
            bypass_llm=top_match.rule.bypass_llm,
            response_template_id=top_match.rule.response_template_id,
            matched_rules=matched_rule_ids,
            should_log=top_match.rule.should_log,
            user_visible_category=top_match.rule.user_visible_category,
            action=top_match.rule.action,
            confidence=confidence,
            rationale=rationale,
        )

        self._enforce_non_bypassable_contract(decision)
        return decision

    def _find_matches(self, text: str, locale: Locale) -> list[SafetyRuleMatch]:
        candidate_rules = self._candidate_rules(locale)
        exclusion_context = self._has_exclusion_context(text, locale)

        matches: list[SafetyRuleMatch] = []

        for rule in candidate_rules:
            matched_refs = self._match_rule(rule, text)

            if not matched_refs:
                continue

            matches.append(
                SafetyRuleMatch(
                    rule=rule,
                    confidence=rule.confidence,
                    matched_pattern_refs=tuple(matched_refs),
                    exclusion_context=exclusion_context,
                )
            )

        return sorted(matches, key=lambda item: (item.priority, item.confidence), reverse=True)

    def _candidate_rules(self, locale: Locale) -> list[CompiledSafetyRule]:
        if locale in SUPPORTED_PATTERN_LOCALES:
            primary = [rule for rule in self._rules if rule.source_locale == locale]
            secondary = [rule for rule in self._rules if rule.source_locale != locale]
            return primary + secondary

        return self._rules

    def _match_rule(self, rule: CompiledSafetyRule, text: str) -> list[str]:
        if rule.match_mode == "any":
            matched_refs: list[str] = []

            for index, pattern in enumerate(rule.patterns):
                if pattern.search(text):
                    matched_refs.append(f"pattern:{index}")

            return matched_refs

        if rule.match_mode == "all_groups":
            matched_refs = []

            for group_name, patterns in rule.pattern_groups.items():
                group_matched = False

                for index, pattern in enumerate(patterns):
                    if pattern.search(text):
                        matched_refs.append(f"group:{group_name}:{index}")
                        group_matched = True
                        break

                if not group_matched:
                    return []

            return matched_refs

        raise SafetyError(
            "Unsupported safety rule match mode",
            code="unsupported_match_mode",
            details={"rule_id": rule.rule_id, "match_mode": rule.match_mode},
        )

    def _has_exclusion_context(self, text: str, locale: Locale) -> bool:
        for exclusion in self._candidate_exclusions(locale):
            if any(pattern.search(text) for pattern in exclusion.patterns):
                return True

        return False

    def _candidate_exclusions(self, locale: Locale) -> list[CompiledExclusionRule]:
        if locale in SUPPORTED_PATTERN_LOCALES:
            primary = [rule for rule in self._exclusion_rules if rule.source_locale == locale]
            secondary = [rule for rule in self._exclusion_rules if rule.source_locale != locale]
            return primary + secondary

        return self._exclusion_rules

    def _collect_matched_rule_ids(
        self,
        matches: list[SafetyRuleMatch],
        top_level: SafetyLevel,
    ) -> list[str]:
        collected: list[str] = []
        seen: set[str] = set()

        for match in matches:
            if match.rule.level != top_level:
                continue

            if match.rule.rule_id in seen:
                continue

            seen.add(match.rule.rule_id)
            collected.append(match.rule.rule_id)

            if len(collected) >= 20:
                break

        return collected

    def _load_pattern_file(
        self,
        locale: Locale,
    ) -> tuple[list[CompiledSafetyRule], list[CompiledExclusionRule]]:
        path = self.safety_dir / f"crisis_patterns_{locale}.yaml"
        data = self._load_yaml_mapping(path)

        if data.get("schema_version") != 1:
            raise SafetyError(
                "Unsupported crisis pattern schema version",
                code="unsupported_safety_schema",
                details={"path": str(path)},
            )

        if normalize_locale(data.get("locale")) != locale:
            raise SafetyError(
                "Safety pattern locale mismatch",
                code="safety_locale_mismatch",
                details={"path": str(path), "expected_locale": locale},
            )

        rules = [
            self._compile_rule(raw_rule, source_locale=locale, path=path)
            for raw_rule in data.get("rules", [])
        ]

        exclusions = [
            self._compile_exclusion(raw_rule, source_locale=locale, path=path)
            for raw_rule in data.get("exclusion_patterns", [])
        ]

        self._assert_unique_ids([rule.rule_id for rule in rules], path, "rule")
        self._assert_unique_ids([rule.rule_id for rule in exclusions], path, "exclusion")

        return rules, exclusions

    def _compile_rule(
        self,
        raw_rule: dict[str, Any],
        *,
        source_locale: Locale,
        path: Path,
    ) -> CompiledSafetyRule:
        required = {
            "id",
            "level",
            "action",
            "bypass_llm",
            "response_template_id",
            "should_log",
            "user_visible_category",
            "confidence",
            "priority",
            "match_mode",
        }

        missing = required.difference(raw_rule)

        if missing:
            raise SafetyError(
                "Safety rule is missing required fields",
                code="invalid_safety_rule",
                details={"path": str(path), "missing": ",".join(sorted(missing))},
            )

        rule_id = sanitize_text(str(raw_rule["id"]), 120)

        try:
            level = SafetyLevel(str(raw_rule["level"]))
            action = SafetyAction(str(raw_rule["action"]))
        except ValueError as exc:
            raise SafetyError(
                "Safety rule contains invalid enum value",
                code="invalid_safety_enum",
                details={"path": str(path), "rule_id": rule_id},
            ) from exc

        confidence = float(raw_rule["confidence"])

        if not 0.0 <= confidence <= 1.0:
            raise SafetyError(
                "Safety rule confidence out of range",
                code="invalid_safety_confidence",
                details={"path": str(path), "rule_id": rule_id},
            )

        match_mode = sanitize_text(str(raw_rule["match_mode"]), 40)
        patterns: tuple[Pattern[str], ...] = ()
        pattern_groups: dict[str, tuple[Pattern[str], ...]] = {}

        if match_mode == "any":
            patterns = self._compile_patterns(
                raw_rule.get("patterns", []),
                path=path,
                rule_id=rule_id,
            )

            if not patterns:
                raise SafetyError(
                    "Safety rule with match_mode=any requires patterns",
                    code="invalid_safety_patterns",
                    details={"path": str(path), "rule_id": rule_id},
                )

        elif match_mode == "all_groups":
            raw_groups = raw_rule.get("pattern_groups", {})

            if not isinstance(raw_groups, dict) or not raw_groups:
                raise SafetyError(
                    "Safety rule with match_mode=all_groups requires pattern_groups",
                    code="invalid_safety_pattern_groups",
                    details={"path": str(path), "rule_id": rule_id},
                )

            pattern_groups = {
                sanitize_text(str(group_name), 80): self._compile_patterns(
                    group_patterns,
                    path=path,
                    rule_id=f"{rule_id}:{group_name}",
                )
                for group_name, group_patterns in raw_groups.items()
            }

            if any(not group_patterns for group_patterns in pattern_groups.values()):
                raise SafetyError(
                    "Safety rule pattern group cannot be empty",
                    code="invalid_safety_pattern_groups",
                    details={"path": str(path), "rule_id": rule_id},
                )

        else:
            raise SafetyError(
                "Unsupported safety rule match mode",
                code="unsupported_match_mode",
                details={"path": str(path), "rule_id": rule_id, "match_mode": match_mode},
            )

        response_template_id = raw_rule.get("response_template_id")

        if response_template_id is not None:
            response_template_id = sanitize_text(str(response_template_id), 120) or None

        rule = CompiledSafetyRule(
            rule_id=rule_id,
            level=level,
            action=action,
            bypass_llm=bool(raw_rule["bypass_llm"]),
            response_template_id=response_template_id,
            should_log=bool(raw_rule["should_log"]),
            user_visible_category=sanitize_text(str(raw_rule["user_visible_category"]), 80),
            confidence=confidence,
            priority=int(raw_rule["priority"]),
            match_mode=match_mode,
            source_locale=source_locale,
            patterns=patterns,
            pattern_groups=pattern_groups,
            rag_tags=tuple(
                sanitize_text(str(tag), 80)
                for tag in raw_rule.get("rag_tags", [])
                if sanitize_text(str(tag), 80)
            ),
        )

        self._validate_compiled_rule_contract(rule, path)
        return rule

    def _compile_exclusion(
        self,
        raw_rule: dict[str, Any],
        *,
        source_locale: Locale,
        path: Path,
    ) -> CompiledExclusionRule:
        rule_id = sanitize_text(str(raw_rule.get("id", "")), 120)

        if not rule_id:
            raise SafetyError(
                "Exclusion rule is missing id",
                code="invalid_exclusion_rule",
                details={"path": str(path)},
            )

        patterns = self._compile_patterns(
            raw_rule.get("patterns", []),
            path=path,
            rule_id=rule_id,
        )

        if not patterns:
            raise SafetyError(
                "Exclusion rule requires patterns",
                code="invalid_exclusion_rule",
                details={"path": str(path), "rule_id": rule_id},
            )

        return CompiledExclusionRule(
            rule_id=rule_id,
            description=sanitize_text(str(raw_rule.get("description", "")), 300),
            source_locale=source_locale,
            patterns=patterns,
        )

    def _load_response_templates(
        self,
    ) -> tuple[dict[str, CrisisResponseTemplate], dict[Locale, str]]:
        path = self.safety_dir / "crisis_responses.yaml"
        data = self._load_yaml_mapping(path)

        if data.get("schema_version") != 1:
            raise SafetyError(
                "Unsupported crisis response schema version",
                code="unsupported_crisis_response_schema",
                details={"path": str(path)},
            )

        templates: dict[str, CrisisResponseTemplate] = {}

        for raw_template in data.get("templates", []):
            template = CrisisResponseTemplate.model_validate(raw_template)

            if template.template_id in templates:
                raise SafetyError(
                    "Duplicate crisis response template id",
                    code="duplicate_crisis_template",
                    details={"template_id": template.template_id},
                )

            templates[template.template_id] = template

        raw_fallbacks = data.get("fallback_templates", {})

        if not isinstance(raw_fallbacks, dict):
            raise SafetyError(
                "fallback_templates must be a mapping",
                code="invalid_crisis_fallbacks",
                details={"path": str(path)},
            )

        fallbacks: dict[Locale, str] = {}

        for raw_locale, raw_template_id in raw_fallbacks.items():
            locale = normalize_locale(str(raw_locale))
            template_id = sanitize_text(str(raw_template_id), 120)

            if template_id not in templates:
                raise SafetyError(
                    "Fallback crisis template does not exist",
                    code="invalid_crisis_fallback",
                    details={"locale": locale, "template_id": template_id},
                )

            fallbacks[locale] = template_id

        if "en" not in fallbacks or "ar" not in fallbacks:
            raise SafetyError(
                "Crisis responses require en and ar fallback templates",
                code="missing_crisis_fallback",
                details={"path": str(path)},
            )

        return templates, fallbacks

    def _validate_compiled_rule_contract(self, rule: CompiledSafetyRule, path: Path) -> None:
        if rule.level == SafetyLevel.SELF_HARM_IMMINENT:
            if not rule.bypass_llm:
                raise SafetyError(
                    "self_harm_imminent rule must bypass LLM",
                    code="invalid_imminent_rule_contract",
                    details={"path": str(path), "rule_id": rule.rule_id},
                )

            if rule.action != SafetyAction.DETERMINISTIC_RESPONSE:
                raise SafetyError(
                    "self_harm_imminent rule must use deterministic_response action",
                    code="invalid_imminent_rule_contract",
                    details={"path": str(path), "rule_id": rule.rule_id},
                )

            if not rule.response_template_id:
                raise SafetyError(
                    "self_harm_imminent rule requires response_template_id",
                    code="invalid_imminent_rule_contract",
                    details={"path": str(path), "rule_id": rule.rule_id},
                )

            if not rule.should_log:
                raise SafetyError(
                    "self_harm_imminent rule must set should_log=true",
                    code="invalid_imminent_rule_contract",
                    details={"path": str(path), "rule_id": rule.rule_id},
                )

        if rule.bypass_llm:
            if rule.action == SafetyAction.CONTINUE_TO_LLM:
                raise SafetyError(
                    "bypass_llm rule cannot continue to LLM",
                    code="invalid_bypass_rule_contract",
                    details={"path": str(path), "rule_id": rule.rule_id},
                )

            if not rule.response_template_id:
                raise SafetyError(
                    "bypass_llm rule requires response_template_id",
                    code="invalid_bypass_rule_contract",
                    details={"path": str(path), "rule_id": rule.rule_id},
                )

    def _enforce_non_bypassable_contract(self, decision: SafetyDecision) -> None:
        if decision.level != SafetyLevel.SELF_HARM_IMMINENT:
            return

        if not decision.bypass_llm:
            raise SafetyError(
                "self_harm_imminent decision must bypass LLM",
                code="imminent_contract_violation",
            )

        if decision.action != SafetyAction.DETERMINISTIC_RESPONSE:
            raise SafetyError(
                "self_harm_imminent decision must use deterministic response",
                code="imminent_contract_violation",
            )

        if not decision.response_template_id:
            raise SafetyError(
                "self_harm_imminent decision requires response_template_id",
                code="imminent_contract_violation",
            )

        if not decision.should_log:
            raise SafetyError(
                "self_harm_imminent decision must set should_log",
                code="imminent_contract_violation",
            )

    def _compile_patterns(
        self,
        patterns: Any,
        *,
        path: Path,
        rule_id: str,
    ) -> tuple[Pattern[str], ...]:
        if not isinstance(patterns, list):
            raise SafetyError(
                "patterns must be a list",
                code="invalid_safety_patterns",
                details={"path": str(path), "rule_id": rule_id},
            )

        compiled: list[Pattern[str]] = []

        for index, raw_pattern in enumerate(patterns):
            pattern_text = str(raw_pattern)

            try:
                compiled.append(re.compile(pattern_text))
            except re.error as exc:
                raise SafetyError(
                    "Invalid safety regex pattern",
                    code="invalid_safety_regex",
                    details={
                        "path": str(path),
                        "rule_id": rule_id,
                        "pattern_index": index,
                        "regex_error": str(exc),
                    },
                ) from exc

        return tuple(compiled)

    @staticmethod
    def _load_yaml_mapping(path: Path) -> dict[str, Any]:
        if not path.exists():
            raise SafetyError(
                "Safety configuration file is missing",
                code="safety_file_missing",
                details={"path": str(path)},
            )

        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
        except yaml.YAMLError as exc:
            raise SafetyError(
                "Safety YAML failed to parse",
                code="safety_yaml_parse_error",
                details={"path": str(path)},
            ) from exc

        if not isinstance(data, dict):
            raise SafetyError(
                "Safety YAML root must be a mapping",
                code="invalid_safety_yaml",
                details={"path": str(path)},
            )

        return data

    @staticmethod
    def _assert_unique_ids(ids: list[str], path: Path, label: str) -> None:
        seen: set[str] = set()

        for item_id in ids:
            if item_id in seen:
                raise SafetyError(
                    f"Duplicate {label} id",
                    code=f"duplicate_{label}_id",
                    details={"path": str(path), "id": item_id},
                )

            seen.add(item_id)


def _clean_provider_name(value: str) -> str:
    return sanitize_text(str(value or ""), 80).lower() or "unknown"


def hash_matched_fragment(fragment: str) -> str:
    cleaned = sanitize_text(fragment, 300)
    digest = hashlib.blake2b(
        cleaned.encode("utf-8"),
        digest_size=16,
        person=b"MindPalSafety",
    ).hexdigest()
    return f"match_{digest}"


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
        raise SafetyError(
            "LLM safety classifier did not contain JSON",
            code="safety_llm_invalid_json",
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

    raise SafetyError(
        "LLM safety classifier JSON object was incomplete",
        code="safety_llm_invalid_json",
    )


def _bounded_float(value: Any, *, default: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default

    return max(0.0, min(parsed, 1.0))


def _clean_rule_ids(value: Any) -> list[str]:
    if value is None:
        return []

    if isinstance(value, str):
        raw_items = [value]
    elif isinstance(value, (list, tuple, set, frozenset)):
        raw_items = list(value)
    else:
        raw_items = [value]

    return _unique_rule_ids([sanitize_text(str(item), 120) for item in raw_items])


def _unique_rule_ids(values: list[str]) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []

    for value in values:
        cleaned = sanitize_text(str(value), 120)

        if not cleaned or cleaned in seen:
            continue

        seen.add(cleaned)
        output.append(cleaned)

        if len(output) >= 50:
            break

    return output


def _default_category_for_level(level: SafetyLevel) -> str:
    return {
        SafetyLevel.SAFE: "general_support",
        SafetyLevel.SUPPORTIVE: "emotional_support",
        SafetyLevel.SELF_HARM_AMBIGUOUS: "emotional_distress",
        SafetyLevel.SELF_HARM_IMMINENT: "immediate_safety",
        SafetyLevel.ABUSE_OR_VIOLENCE: "personal_safety",
        SafetyLevel.TOXICITY: "deescalation",
    }[level]


def _imminent_template_for_locale(locale: Locale) -> str:
    return "imminent_self_harm_ar" if locale == "ar" else "imminent_self_harm_en"

