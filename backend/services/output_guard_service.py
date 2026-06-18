# backend/services/output_guard_service.py

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from re import Pattern
from typing import Any, Literal

import yaml

from backend.core.config import Settings, get_settings
from backend.core.errors import SafetyError
from backend.core.security import Locale, normalize_locale, safe_truncate, sanitize_text
from backend.core.settings_helpers import is_production, setting_bool, setting_value
from backend.services.llm_service import LLMService, build_llm_request

logger = logging.getLogger(__name__)


MAX_OUTPUT_TEXT_CHARS = 12_000
MAX_FALLBACK_TEXT_CHARS = 1_500
MAX_REWRITE_INPUT_CHARS = 4_000
MAX_REWRITE_OUTPUT_CHARS = 2_000

OutputAction = Literal["allow", "safe_rewrite", "block_and_fallback", "annotate_for_review"]
OutputSeverity = Literal["low", "medium", "high", "critical"]

VALID_POLICY_ACTIONS: frozenset[str] = frozenset(
    {
        "safe_rewrite",
        "block_and_fallback",
        "annotate_for_review",
    }
)

VALID_SEVERITIES: frozenset[str] = frozenset(
    {
        "low",
        "medium",
        "high",
        "critical",
    }
)

CRITICAL_CATEGORIES: frozenset[str] = frozenset(
    {
        "self_harm_instruction",
        "violence_instruction",
        "medication_instruction",
    }
)

OUTPUT_REWRITE_SYSTEM_PROMPT = """
You are MindPal's output safety rewrite engine.

Rewrite the assistant response so it is safe, brief, and still helpful.

Rules:
- Return JSON only.
- Do not include unsafe original wording.
- Do not diagnose.
- Do not provide medication dose/start/stop/change instructions.
- Do not provide self-harm instructions.
- Do not provide violence instructions.
- Do not claim to be a therapist.
- Do not create dependency.
- Do not promise certainty, safety, cure, or guaranteed recovery.
- Keep the rewrite as general wellness support.
- If the unsafe issue is diagnostic certainty, replace it with non-diagnostic wording.
- If the unsafe issue is therapist/clinical authority claim, replace it with wellness-support boundary.
- If the unsafe issue is dependency language, encourage trusted real-world support.

Return exactly:
{
  "rewrite": "safe assistant response"
}
""".strip()


@dataclass(frozen=True, slots=True)
class CompiledOutputRule:
    rule_id: str
    category: str
    severity: OutputSeverity
    action: OutputAction
    confidence: float
    description: str
    patterns: tuple[Pattern[str], ...]


@dataclass(frozen=True, slots=True)
class OutputGuardMatch:
    rule_id: str
    category: str
    severity: OutputSeverity
    action: OutputAction
    confidence: float
    pattern_index: int


@dataclass(frozen=True, slots=True)
class OutputGuardResult:
    is_safe: bool
    action: OutputAction
    final_text: str
    matched_rules: tuple[str, ...]
    matches: tuple[OutputGuardMatch, ...]
    blocked_original: bool
    locale: Locale
    rewrite_attempted: bool = False
    rewrite_succeeded: bool = False
    rewrite_provider: str | None = None
    fallback_used: bool = False
    error_code: str | None = None

    @property
    def should_return_original(self) -> bool:
        return self.is_safe and self.action == "allow" and not self.blocked_original

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "is_safe": self.is_safe,
            "action": self.action,
            "matched_rules": list(self.matched_rules),
            "blocked_original": self.blocked_original,
            "locale": self.locale,
            "rewrite_attempted": self.rewrite_attempted,
            "rewrite_succeeded": self.rewrite_succeeded,
            "rewrite_provider": self.rewrite_provider,
            "fallback_used": self.fallback_used,
            "error_code": self.error_code,
        }


class OutputGuardService:
    """
    Post-generation safety guard.

    Deterministic role:
    - detect unsafe generated output
    - block critical unsafe categories
    - provide fallback when needed

    LLM-assisted role:
    - for non-critical unsafe categories only, optionally ask LLM to rewrite safely
    - validate the rewrite again before returning it
    """

    def __init__(
        self,
        safety_dir: Path | None = None,
        *,
        settings: Settings | None = None,
        llm_service: LLMService | None = None,
        enable_llm_rewrite: bool | None = None,
        allow_offline_llm_rewrite: bool | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.production_mode = is_production(self.settings)

        self.safety_dir = safety_dir or Path(__file__).resolve().parents[1] / "safety"
        self.llm_service = llm_service

        self.enable_llm_rewrite = (
            setting_bool(
                self.settings,
                "ENABLE_LLM_OUTPUT_REWRITE",
                default=True,
            )
            if enable_llm_rewrite is None
            else bool(enable_llm_rewrite)
        )

        self.allow_offline_llm_rewrite = (
            setting_bool(
                self.settings,
                "ALLOW_OFFLINE_LLM_OUTPUT_REWRITE",
                default=False,
            )
            if allow_offline_llm_rewrite is None
            else bool(allow_offline_llm_rewrite)
        )

        self._rules: list[CompiledOutputRule] = []
        self._default_action: OutputAction = "safe_rewrite"
        self._fallbacks: dict[Locale, str] = {}
        self._rewrite_guidelines: dict[Locale, list[str]] = {}
        self._actions: dict[str, dict[str, Any]] = {}

        self.reload()

    def reload(self) -> None:
        data = self._load_policy_file()

        self._default_action = self._parse_policy_action(data.get("default_action", "safe_rewrite"))
        self._fallbacks = self._load_fallbacks(data)
        self._rules = self._load_rules(data)
        self._rewrite_guidelines = self._load_rewrite_guidelines(data)
        self._actions = self._load_actions(data)

    def validate_output(
        self,
        generated_text: str,
        *,
        locale: str | None = "auto",
    ) -> OutputGuardResult:
        """
        Deterministic local validation only.

        This method is sync and safe to use in tests/fallbacks. The upgraded
        async method is validate_output_with_rewrite().
        """
        return self._validate_output_local(generated_text, locale=locale)

    async def validate_output_with_rewrite(
        self,
        generated_text: str,
        *,
        locale: str | None = "auto",
    ) -> OutputGuardResult:
        """
        Full upgraded path.

        - safe output returns original sanitized output
        - critical unsafe output returns deterministic fallback
        - non-critical unsafe output attempts LLM safe rewrite
        - rewrite is scanned again before returning
        - unsafe rewrite falls back deterministically
        """
        local_result = self._validate_output_local(generated_text, locale=locale)

        if local_result.is_safe:
            return local_result

        if not self._should_attempt_llm_rewrite(local_result):
            return local_result

        try:
            rewrite_text, provider_used = await self._rewrite_with_llm(
                generated_text,
                local_result=local_result,
            )

            rewrite_scan = self._validate_output_local(rewrite_text, locale=locale)

            if rewrite_scan.is_safe:
                return OutputGuardResult(
                    is_safe=True,
                    action="safe_rewrite",
                    final_text=rewrite_scan.final_text,
                    matched_rules=local_result.matched_rules,
                    matches=local_result.matches,
                    blocked_original=True,
                    locale=local_result.locale,
                    rewrite_attempted=True,
                    rewrite_succeeded=True,
                    rewrite_provider=provider_used,
                    fallback_used=False,
                )

            return OutputGuardResult(
                is_safe=False,
                action=local_result.action,
                final_text=self.get_default_fallback(local_result.locale),
                matched_rules=local_result.matched_rules,
                matches=local_result.matches,
                blocked_original=True,
                locale=local_result.locale,
                rewrite_attempted=True,
                rewrite_succeeded=False,
                rewrite_provider=provider_used,
                fallback_used=True,
                error_code="rewrite_failed_output_guard",
            )

        except Exception as exc:
            return OutputGuardResult(
                is_safe=False,
                action=local_result.action,
                final_text=self.get_default_fallback(local_result.locale),
                matched_rules=local_result.matched_rules,
                matches=local_result.matches,
                blocked_original=True,
                locale=local_result.locale,
                rewrite_attempted=True,
                rewrite_succeeded=False,
                rewrite_provider=None,
                fallback_used=True,
                error_code=exc.__class__.__name__,
            )

    async def assert_safe_output(
        self,
        generated_text: str,
        *,
        locale: str | None = "auto",
    ) -> str:
        return (
            await self.validate_output_with_rewrite(generated_text, locale=locale)
        ).final_text

    def assert_safe_output_local(
        self,
        generated_text: str,
        *,
        locale: str | None = "auto",
    ) -> str:
        return self.validate_output(generated_text, locale=locale).final_text

    def get_default_fallback(self, locale: str | None = "auto") -> str:
        resolved_locale = normalize_locale(locale)

        if resolved_locale in self._fallbacks:
            return self._fallbacks[resolved_locale]

        if resolved_locale == "auto" and "en" in self._fallbacks:
            return self._fallbacks["en"]

        if "en" in self._fallbacks:
            return self._fallbacks["en"]

        raise SafetyError(
            "Output guard fallback is missing",
            code="output_guard_fallback_missing",
            details={"locale": resolved_locale},
        )

    def health(self) -> dict[str, Any]:
        rewrite_provider_state = self._rewrite_provider_state()

        return {
            "mode": "deterministic_blocker_with_optional_llm_rewrite",
            "production_mode": self.production_mode,
            "rules_loaded": len(self._rules),
            "fallback_locales": sorted(self._fallbacks),
            "default_action": self._default_action,
            "actions_loaded": sorted(self._actions),
            "llm_rewrite_enabled": self.enable_llm_rewrite,
            "llm_service_available": self.llm_service is not None,
            "llm_rewrite_provider_state": rewrite_provider_state,
            "llm_rewrite_can_call_llm": rewrite_provider_state["rewrite_can_call_llm"],
            "offline_llm_rewrite_allowed": self.allow_offline_llm_rewrite,
            "critical_categories_never_rewritten": sorted(CRITICAL_CATEGORIES),
            "rewrites_are_rescanned": True,
            "unsafe_rewrite_falls_back": True,
        }

    def _validate_output_local(
        self,
        generated_text: str,
        *,
        locale: str | None = "auto",
    ) -> OutputGuardResult:
        resolved_locale = normalize_locale(locale)
        cleaned = sanitize_text(generated_text, MAX_OUTPUT_TEXT_CHARS)

        if not cleaned:
            fallback = self.get_default_fallback(resolved_locale)
            return OutputGuardResult(
                is_safe=False,
                action="block_and_fallback",
                final_text=fallback,
                matched_rules=("empty_output",),
                matches=(),
                blocked_original=True,
                locale=resolved_locale,
                fallback_used=True,
                error_code="empty_output",
            )

        matches = self._find_matches(cleaned)

        if not matches:
            return OutputGuardResult(
                is_safe=True,
                action="allow",
                final_text=cleaned,
                matched_rules=(),
                matches=(),
                blocked_original=False,
                locale=resolved_locale,
            )

        action = self._resolve_action(matches)
        fallback = self._build_safe_replacement(
            action=action,
            locale=resolved_locale,
            matches=matches,
        )

        return OutputGuardResult(
            is_safe=False,
            action=action,
            final_text=fallback,
            matched_rules=tuple(_unique_ordered(match.rule_id for match in matches)),
            matches=tuple(matches),
            blocked_original=True,
            locale=resolved_locale,
            fallback_used=True,
        )

    def _should_attempt_llm_rewrite(self, result: OutputGuardResult) -> bool:
        if not self.enable_llm_rewrite or self.llm_service is None:
            return False

        provider_state = self._rewrite_provider_state()
        if not provider_state["rewrite_can_call_llm"]:
            return False

        if result.action == "block_and_fallback":
            return False

        categories = {match.category for match in result.matches}

        if categories.intersection(CRITICAL_CATEGORIES):
            return False

        return True

    def _rewrite_provider_state(self) -> dict[str, bool]:
        if self.llm_service is None:
            return {
                "remote_provider_available": False,
                "offline_available": False,
                "offline_allowed_by_llm_service": False,
                "offline_allowed_for_output_rewrite": self.allow_offline_llm_rewrite,
                "rewrite_can_call_llm": False,
            }

        try:
            health = self.llm_service.health()
        except Exception:
            logger.warning("LLM service health check failed for output guard rewrite", exc_info=True)
            return {
                "remote_provider_available": False,
                "offline_available": False,
                "offline_allowed_by_llm_service": False,
                "offline_allowed_for_output_rewrite": self.allow_offline_llm_rewrite,
                "rewrite_can_call_llm": False,
            }

        remote_available = bool(
            health.get("configured_remote_provider_available", False)
            or health.get("remote_provider_available", False)
        )
        offline_available = bool(health.get("offline_available", False))
        offline_allowed_by_llm_service = bool(health.get("offline_allowed", False))

        rewrite_can_call_llm = bool(
            remote_available
            or (
                self.allow_offline_llm_rewrite
                and offline_available
                and offline_allowed_by_llm_service
            )
        )

        return {
            "remote_provider_available": remote_available,
            "offline_available": offline_available,
            "offline_allowed_by_llm_service": offline_allowed_by_llm_service,
            "offline_allowed_for_output_rewrite": self.allow_offline_llm_rewrite,
            "rewrite_can_call_llm": rewrite_can_call_llm,
        }

    async def _rewrite_with_llm(
        self,
        generated_text: str,
        *,
        local_result: OutputGuardResult,
    ) -> tuple[str, str]:
        if self.llm_service is None:
            raise SafetyError(
                "Output guard LLM rewrite requested without LLM service",
                code="output_guard_llm_missing",
            )

        payload = {
            "locale": local_result.locale,
            "unsafe_categories": sorted({match.category for match in local_result.matches}),
            "matched_rules": list(local_result.matched_rules),
            "unsafe_response": sanitize_text(generated_text, MAX_REWRITE_INPUT_CHARS),
            "fallback_boundary": self.get_default_fallback(local_result.locale),
        }

        request = build_llm_request(
            request_id="output_guard_rewrite",
            system_prompt=OUTPUT_REWRITE_SYSTEM_PROMPT,
            user_message=json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            temperature=0.1,
            max_output_tokens=500,
            metadata={
                "purpose": "output_guard_safe_rewrite",
                "critical_rewrite_allowed": False,
            },
        )

        result = await self.llm_service.generate_with_trace(request)
        response = result.response
        provider_used = sanitize_text(response.provider_used or "unknown", 80)

        if _clean_provider_name(provider_used) == "offline" and not self.allow_offline_llm_rewrite:
            raise SafetyError(
                "Offline LLM fallback cannot be used for output guard rewrite",
                code="output_guard_offline_rewrite_disabled",
            )

        rewrite = self._parse_rewrite_json(response.text)

        if not rewrite:
            raise SafetyError(
                "Output guard LLM rewrite returned empty rewrite",
                code="output_guard_empty_rewrite",
            )

        return rewrite, provider_used

    def _parse_rewrite_json(self, text: str) -> str:
        cleaned = sanitize_text(text, MAX_REWRITE_OUTPUT_CHARS).strip()
        cleaned = _strip_code_fence(cleaned)
        json_text = _extract_json_object(cleaned)

        try:
            payload = json.loads(json_text)
        except json.JSONDecodeError as exc:
            raise SafetyError(
                "Output guard rewrite JSON failed to parse",
                code="output_guard_rewrite_invalid_json",
            ) from exc

        if not isinstance(payload, dict):
            raise SafetyError(
                "Output guard rewrite must be a JSON object",
                code="output_guard_rewrite_invalid_shape",
            )

        rewrite = sanitize_text(str(payload.get("rewrite", "")), MAX_REWRITE_OUTPUT_CHARS)
        return rewrite

    def _find_matches(self, text: str) -> list[OutputGuardMatch]:
        matches: list[OutputGuardMatch] = []

        for rule in self._rules:
            for index, pattern in enumerate(rule.patterns):
                if not pattern.search(text):
                    continue

                matches.append(
                    OutputGuardMatch(
                        rule_id=rule.rule_id,
                        category=rule.category,
                        severity=rule.severity,
                        action=rule.action,
                        confidence=rule.confidence,
                        pattern_index=index,
                    )
                )

        return sorted(
            matches,
            key=lambda item: (
                _severity_rank(item.severity),
                _action_rank(item.action),
                item.confidence,
            ),
            reverse=True,
        )

    def _resolve_action(self, matches: list[OutputGuardMatch]) -> OutputAction:
        if any(match.action == "block_and_fallback" for match in matches):
            return "block_and_fallback"

        if any(match.severity == "critical" for match in matches):
            return "block_and_fallback"

        if any(match.action == "annotate_for_review" for match in matches):
            return "annotate_for_review"

        if any(match.action == "safe_rewrite" for match in matches):
            return "safe_rewrite"

        return self._default_action

    def _build_safe_replacement(
        self,
        *,
        action: OutputAction,
        locale: Locale,
        matches: list[OutputGuardMatch],
    ) -> str:
        fallback = self.get_default_fallback(locale)

        categories = set(match.category for match in matches)

        if categories.intersection({"self_harm_instruction", "violence_instruction"}):
            return fallback

        if "medication_instruction" in categories:
            if locale == "ar":
                return (
                    "أقدر أساعدك بخطوات دعم نفسي عامة وآمنة، لكن لا أقدر أقدم "
                    "تعليمات دوائية أو جرعات أو تغييرات في العلاج. لو عندك سؤال عن دواء، "
                    "راجع طبيب أو صيدلي. قلّي حاسس بإيه دلوقتي ونختار خطوة آمنة واحدة."
                )

            return (
                "I can support you with general wellness steps, but I can’t provide "
                "medication dosages or instructions to start, stop, or change treatment. "
                "For medication questions, ask a doctor or pharmacist. Tell me what you’re "
                "feeling right now, and I’ll help you choose one safe next step."
            )

        if "diagnosis_certainty" in categories:
            if locale == "ar":
                return (
                    "لا أقدر أشخصك أو أقول إن عندك اضطراب بشكل مؤكد. أقدر أساعدك تفهم "
                    "المشاعر أو الأعراض بشكل عام ونختار خطوة دعم آمنة الآن."
                )

            return (
                "I can’t diagnose you or say with certainty that you have a disorder. "
                "I can help you look at what you’re feeling in general terms and choose "
                "one safe support step now."
            )

        if "therapist_claim" in categories or "clinical_overclaim" in categories:
            if locale == "ar":
                return (
                    "أنا أقدر أقدم دعم نفسي عام وآمن، لكني لست معالجًا أو بديلًا عن "
                    "مساعدة مهنية. قلّي ما الذي يحدث الآن، وسأساعدك بخطوة عملية واحدة."
                )

            return (
                "I can provide general wellness support, but I’m not a therapist or a "
                "replacement for professional help. Tell me what is happening right now, "
                "and I’ll help with one practical next step."
            )

        if "dependency_language" in categories:
            if locale == "ar":
                return (
                    "أنا موجود لدعمك، لكن من الأفضل أيضًا إشراك شخص موثوق في حياتك "
                    "عندما تحتاج دعمًا حقيقيًا. ما خطوة واحدة آمنة يمكنك فعلها الآن؟"
                )

            return (
                "I can support you here, and it’s also important to involve trusted people "
                "in your life when you need real support. What is one safe step you can take now?"
            )

        if action == "annotate_for_review":
            return fallback

        return fallback

    def _load_policy_file(self) -> dict[str, Any]:
        path = self.safety_dir / "prohibited_outputs.yaml"

        if not path.exists():
            raise SafetyError(
                "Output guard policy file is missing",
                code="output_guard_file_missing",
                details={"path": str(path)},
            )

        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
        except yaml.YAMLError as exc:
            raise SafetyError(
                "Output guard YAML failed to parse",
                code="output_guard_yaml_parse_error",
                details={"path": str(path)},
            ) from exc

        if not isinstance(data, dict):
            raise SafetyError(
                "Output guard YAML root must be a mapping",
                code="invalid_output_guard_yaml",
                details={"path": str(path)},
            )

        if data.get("schema_version") != 1:
            raise SafetyError(
                "Unsupported output guard schema version",
                code="unsupported_output_guard_schema",
                details={"path": str(path)},
            )

        return data

    def _load_fallbacks(self, data: dict[str, Any]) -> dict[Locale, str]:
        raw_fallbacks = data.get("default_safe_fallback")

        if not isinstance(raw_fallbacks, dict):
            raise SafetyError(
                "default_safe_fallback must be a mapping",
                code="invalid_output_guard_fallbacks",
            )

        fallbacks: dict[Locale, str] = {}

        for raw_locale, raw_text in raw_fallbacks.items():
            locale = normalize_locale(str(raw_locale))
            text = sanitize_text(str(raw_text or ""), MAX_FALLBACK_TEXT_CHARS)

            if not text:
                raise SafetyError(
                    "Output guard fallback text cannot be empty",
                    code="invalid_output_guard_fallback",
                    details={"locale": locale},
                )

            fallbacks[locale] = text

        if "en" not in fallbacks or "ar" not in fallbacks:
            raise SafetyError(
                "Output guard requires en and ar default fallbacks",
                code="missing_output_guard_fallback",
            )

        return fallbacks

    def _load_rules(self, data: dict[str, Any]) -> list[CompiledOutputRule]:
        raw_rules = data.get("rules")

        if not isinstance(raw_rules, list) or not raw_rules:
            raise SafetyError(
                "Output guard requires at least one rule",
                code="missing_output_guard_rules",
            )

        rules: list[CompiledOutputRule] = []
        seen_ids: set[str] = set()

        for raw_rule in raw_rules:
            if not isinstance(raw_rule, dict):
                raise SafetyError(
                    "Output guard rule must be a mapping",
                    code="invalid_output_guard_rule",
                )

            rule = self._compile_rule(raw_rule)

            if rule.rule_id in seen_ids:
                raise SafetyError(
                    "Duplicate output guard rule id",
                    code="duplicate_output_guard_rule",
                    details={"rule_id": rule.rule_id},
                )

            seen_ids.add(rule.rule_id)
            rules.append(rule)

        return rules

    def _compile_rule(self, raw_rule: dict[str, Any]) -> CompiledOutputRule:
        required = {
            "id",
            "category",
            "severity",
            "action",
            "confidence",
            "description",
            "patterns",
        }

        missing = required.difference(raw_rule)
        if missing:
            raise SafetyError(
                "Output guard rule is missing required fields",
                code="invalid_output_guard_rule",
                details={"missing": ",".join(sorted(missing))},
            )

        rule_id = sanitize_text(str(raw_rule["id"]), 120)
        category = sanitize_text(str(raw_rule["category"]), 120)
        severity = sanitize_text(str(raw_rule["severity"]), 40)
        action = self._parse_policy_action(raw_rule["action"])
        confidence = float(raw_rule["confidence"])
        description = sanitize_text(str(raw_rule["description"]), 300)

        if not rule_id or not category:
            raise SafetyError(
                "Output guard rule id/category cannot be empty",
                code="invalid_output_guard_rule",
            )

        if severity not in VALID_SEVERITIES:
            raise SafetyError(
                "Invalid output guard severity",
                code="invalid_output_guard_severity",
                details={"rule_id": rule_id, "severity": severity},
            )

        if not 0.0 <= confidence <= 1.0:
            raise SafetyError(
                "Output guard confidence out of range",
                code="invalid_output_guard_confidence",
                details={"rule_id": rule_id},
            )

        if category in CRITICAL_CATEGORIES and action != "block_and_fallback":
            raise SafetyError(
                "Critical output guard categories must use block_and_fallback",
                code="invalid_critical_output_guard_action",
                details={"rule_id": rule_id, "category": category},
            )

        patterns = self._compile_patterns(raw_rule.get("patterns"), rule_id=rule_id)

        return CompiledOutputRule(
            rule_id=rule_id,
            category=category,
            severity=severity,  # type: ignore[arg-type]
            action=action,
            confidence=confidence,
            description=description,
            patterns=patterns,
        )

    def _compile_patterns(self, patterns: Any, *, rule_id: str) -> tuple[Pattern[str], ...]:
        if not isinstance(patterns, list) or not patterns:
            raise SafetyError(
                "Output guard rule requires non-empty patterns list",
                code="invalid_output_guard_patterns",
                details={"rule_id": rule_id},
            )

        compiled: list[Pattern[str]] = []

        for index, raw_pattern in enumerate(patterns):
            try:
                compiled.append(re.compile(str(raw_pattern)))
            except re.error as exc:
                raise SafetyError(
                    "Invalid output guard regex pattern",
                    code="invalid_output_guard_regex",
                    details={
                        "rule_id": rule_id,
                        "pattern_index": index,
                        "regex_error": str(exc),
                    },
                ) from exc

        return tuple(compiled)

    def _load_rewrite_guidelines(self, data: dict[str, Any]) -> dict[Locale, list[str]]:
        raw_guidelines = data.get("safe_rewrite_guidelines", {})

        if not isinstance(raw_guidelines, dict):
            raise SafetyError(
                "safe_rewrite_guidelines must be a mapping",
                code="invalid_safe_rewrite_guidelines",
            )

        guidelines: dict[Locale, list[str]] = {}

        for raw_locale, raw_items in raw_guidelines.items():
            locale = normalize_locale(str(raw_locale))

            if not isinstance(raw_items, list):
                raise SafetyError(
                    "safe_rewrite_guidelines locale value must be a list",
                    code="invalid_safe_rewrite_guidelines",
                    details={"locale": locale},
                )

            guidelines[locale] = [
                sanitize_text(str(item), 300)
                for item in raw_items
                if sanitize_text(str(item), 300)
            ]

        return guidelines

    def _load_actions(self, data: dict[str, Any]) -> dict[str, dict[str, Any]]:
        raw_actions = data.get("actions", {})

        if not isinstance(raw_actions, dict):
            raise SafetyError(
                "actions must be a mapping",
                code="invalid_output_guard_actions",
            )

        actions: dict[str, dict[str, Any]] = {}

        for action_name, action_config in raw_actions.items():
            action = self._parse_policy_action(action_name)

            if not isinstance(action_config, dict):
                raise SafetyError(
                    "output guard action config must be a mapping",
                    code="invalid_output_guard_action_config",
                    details={"action": action},
                )

            if bool(action_config.get("return_original", False)):
                raise SafetyError(
                    "Output guard actions must not return original unsafe output",
                    code="unsafe_output_guard_action",
                    details={"action": action},
                )

            actions[action] = dict(action_config)

        for required_action in VALID_POLICY_ACTIONS:
            if required_action not in actions:
                raise SafetyError(
                    "Output guard action definition missing",
                    code="missing_output_guard_action",
                    details={"action": required_action},
                )

        return actions

    @staticmethod
    def _parse_policy_action(value: Any) -> OutputAction:
        action = sanitize_text(str(value or ""), 80)

        if action not in VALID_POLICY_ACTIONS:
            raise SafetyError(
                "Invalid output guard action",
                code="invalid_output_guard_action",
                details={"action": action},
            )

        return action  # type: ignore[return-value]


def _clean_provider_name(value: str) -> str:
    return sanitize_text(str(value or ""), 80).lower() or "unknown"


def _severity_rank(severity: OutputSeverity) -> int:
    return {
        "low": 1,
        "medium": 2,
        "high": 3,
        "critical": 4,
    }[severity]


def _action_rank(action: OutputAction) -> int:
    return {
        "allow": 0,
        "safe_rewrite": 1,
        "annotate_for_review": 2,
        "block_and_fallback": 3,
    }[action]


def _unique_ordered(values: Any) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []

    for value in values:
        item = sanitize_text(str(value), 120)

        if not item or item in seen:
            continue

        seen.add(item)
        output.append(item)

    return output


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
            "Output guard rewrite did not contain JSON",
            code="output_guard_rewrite_invalid_json",
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
        "Output guard rewrite JSON object was incomplete",
        code="output_guard_rewrite_invalid_json",
    )

