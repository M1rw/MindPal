"""Chat orchestration helpers for sync and streaming chat endpoints.

Contains deterministic chat context question answering, profile loading, usage mirroring,
clinical extraction, safety event logging, and memory graph inline persistence.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import Sequence
from typing import Any, Final

from backend.core.security import sanitize_text
from backend.models.chat import ChatRequest, ChatSafetyView, LLMMessage, LLMRole
from backend.models.memory import MemoryGraph
from backend.models.safety import SafetyDecision
from backend.models.user import UserProfile
from backend.services.domain.memory import extract_memory_graph_from_text_llm

logger = logging.getLogger(__name__)

ARABIC_CHAR_PATTERN: Final[re.Pattern[str]] = re.compile(r"[\u0600-\u06ff]")
MAX_HISTORY_FOR_LLM: Final[int] = 30
MAX_USER_PREFS_PROMPT_CHARS: Final[int] = 1_200
MEMORY_COMPACTION_TIMEOUT_SECONDS: Final[float] = 8.0
SAFETY_EVENT_TIMEOUT_SECONDS: Final[float] = 4.0


def maybe_answer_chat_context_question(payload: ChatRequest) -> str | None:
    """
    Provide deterministic answers for meta-questions about the current chat context state.

    Args:
        payload: Incoming ChatRequest payload.

    Returns:
        Formatted deterministic answer string, or None if message is not a meta-question.
    """
    message = sanitize_text(payload.message or "", 800)
    lowered = message.lower()

    if not _looks_like_chat_count_question(lowered, message):
        return None

    stats = chat_history_stats(payload)
    is_arabic = _contains_arabic_text(message)

    if _asks_user_message_count(lowered, message):
        if is_arabic:
            return f"إنت بعت {stats['user_messages']} رسالة في الشات ده لحد دلوقتي."
        return f"You have sent {stats['user_messages']} messages in this chat so far."

    if _asks_assistant_message_count(lowered, message):
        if is_arabic:
            return f"MindPal رد بـ {stats['assistant_messages']} رسالة في الشات ده لحد دلوقتي."
        return f"MindPal has sent {stats['assistant_messages']} messages in this chat so far."

    if is_arabic:
        return (
            f"فيه {stats['total_messages']} رسالة في الشات ده لحد دلوقتي: "
            f"{stats['user_messages']} منك و {stats['assistant_messages']} من MindPal."
        )

    return (
        f"There are {stats['total_messages']} messages in this chat so far: "
        f"{stats['user_messages']} from you and {stats['assistant_messages']} from MindPal."
    )


def chat_history_stats(payload: ChatRequest) -> dict[str, int]:
    """
    Calculate statistical counts of user vs assistant messages in conversation history.

    Args:
        payload: Active ChatRequest payload.

    Returns:
        Dictionary mapping message category names to message counts.
    """
    history = list(payload.history or [])
    history_includes_current = _history_includes_current_user_message(payload, history)

    total_messages = len(history) if history_includes_current else len(history) + 1
    user_messages = 0
    assistant_messages = 0

    for item in history:
        match _history_role(item):
            case "user":
                user_messages += 1
            case "assistant":
                assistant_messages += 1
            case _:
                pass

    if not history_includes_current:
        user_messages += 1

    return {
        "total_messages": max(0, total_messages),
        "user_messages": max(0, user_messages),
        "assistant_messages": max(0, assistant_messages),
    }


def build_user_preferences_prompt(profile: UserProfile, metadata: Any | None = None) -> str:
    """
    Construct user preference system prompt instructions from profile and client metadata.

    Args:
        profile: UserProfile object containing preference attributes.
        metadata: Request metadata container.

    Returns:
        Sanitized prompt segment detailing personal communication preferences.
    """
    preferences = profile.preferences
    parts: list[str] = [f"communication_style={preferences.communication_style.value}"]

    if preferences.preferred_name:
        parts.append(f"preferred_name={preferences.preferred_name}")

    if preferences.gender:
        parts.append(f"gender={preferences.gender}")
        if preferences.gender == "male":
            parts.append("IMPORTANT: User is male. In Arabic, use masculine grammar (أنت مش إنتي, عملت مش عملتي).")
        elif preferences.gender == "female":
            parts.append("IMPORTANT: User is female. In Arabic, use feminine grammar (إنتي مش أنت, عملتي مش عملت).")

    if preferences.preferred_coping_tools:
        parts.append("preferred_coping_tools=" + ", ".join(preferences.preferred_coping_tools[:10]))

    if preferences.wellness_goals:
        parts.append("wellness_goals=" + ", ".join(preferences.wellness_goals[:10]))

    if preferences.avoided_topics:
        parts.append("avoided_topics=" + ", ".join(preferences.avoided_topics[:10]))

    if preferences.custom_instructions:
        parts.append(f"custom_instructions={preferences.custom_instructions}")

    if metadata:
        if getattr(metadata, "communication_style", None):
            parts.append(f"client_communication_style={metadata.communication_style}")
        if getattr(metadata, "directness", None):
            parts.append(f"client_directness={metadata.directness}")
        if getattr(metadata, "egyptian_arabic_style", None):
            parts.append(f"client_egyptian_arabic_style={metadata.egyptian_arabic_style}")
        if getattr(metadata, "cognitive_structure", None) is not None:
            parts.append(f"client_cognitive_structure={metadata.cognitive_structure}")
        if getattr(metadata, "fast_answers", None) is not None:
            parts.append(f"client_fast_answers={metadata.fast_answers}")
        if getattr(metadata, "custom_instructions", None):
            parts.append(f"client_custom_instructions={metadata.custom_instructions}")

    if hasattr(profile, "clinical") and profile.clinical:
        clinical = profile.clinical
        if clinical.presenting_problems:
            parts.append("presenting_problems=" + ", ".join(clinical.presenting_problems))
        if clinical.suspected_diagnoses:
            parts.append("suspected_diagnoses=" + ", ".join(clinical.suspected_diagnoses))
        if clinical.treatment_plan:
            parts.append(f"treatment_plan={clinical.treatment_plan}")
        if clinical.phq9_history:
            scores = ", ".join(f"{item.score} ({item.date})" for item in clinical.phq9_history[-5:])
            parts.append(f"phq9_history=[{scores}]")
        if clinical.gad7_history:
            scores = ", ".join(f"{item.score} ({item.date})" for item in clinical.gad7_history[-5:])
            parts.append(f"gad7_history=[{scores}]")

    return sanitize_text("\n".join(parts), MAX_USER_PREFS_PROMPT_CHARS)


async def load_chat_profile(
    *,
    services: Any,
    context: Any,
    authenticated: bool,
) -> UserProfile:
    """
    Load active UserProfile from persistence layer or return anonymous guest profile.
    """
    if not authenticated:
        return UserProfile(
            user_id_hash=context.session.user_id_hash,
            channel=context.session.channel,
        )

    profile_response = await services.db.load_user_profile(context.session.user_id_hash)
    return profile_response.profile


async def persist_safety_event_inline(
    *,
    services: Any,
    context: Any,
    decision: SafetyDecision,
    locale: str,
) -> bool:
    """
    Persist safety decision audit event in database within bounded timeout.
    """
    try:
        event = services.safety.build_safety_event(
            request_id=context.request_id,
            user_id_hash=context.session.user_id_hash,
            decision=decision,
            locale=locale,
        )

        await asyncio.wait_for(
            services.db.append_safety_event(event),
            timeout=SAFETY_EVENT_TIMEOUT_SECONDS,
        )

        return True
    except (asyncio.TimeoutError, Exception):
        logger.debug("Safety event persistence failed for %s", context.request_id)
        return False


async def persist_memory_graph_inline(
    *,
    payload: ChatRequest,
    reply: str,
    services: Any,
    context: Any,
    existing_graph: MemoryGraph,
    locale: str,
) -> dict[str, MemoryGraph] | None:
    """
    Extract and persist memory graph atomic facts inline for authenticated users.
    """
    if not bool(context.session.authenticated):
        return None

    try:
        delta = await asyncio.wait_for(
            extract_memory_graph_from_text_llm(
                payload.message,
                user_id_hash=context.session.user_id_hash,
                llm_service=services.llm,
            ),
            timeout=MEMORY_COMPACTION_TIMEOUT_SECONDS,
        )
        if not delta.atoms:
            return None

        merged = await asyncio.wait_for(
            services.memory_repo.merge(
                user_id_hash=context.session.user_id_hash,
                delta=delta,
            ),
            timeout=MEMORY_COMPACTION_TIMEOUT_SECONDS,
        )
        if not merged.changed:
            return None
        return {"delta": delta, "snapshot": merged.snapshot}
    except (asyncio.TimeoutError, Exception):
        logger.warning("Memory graph persistence failed for %s", context.request_id, exc_info=True)
        return None


async def extract_clinical_inline(
    *,
    services: Any,
    profile: UserProfile,
    context: Any,
    messages: list[LLMMessage],
) -> None:
    """
    Perform clinical intelligence extraction on message context asynchronously.
    """
    from backend.services.domain.intelligence import extract_clinical_profile

    try:
        updated = await asyncio.wait_for(
            extract_clinical_profile(
                llm=services.llm,
                messages=messages,
                current_profile=profile.clinical,
            ),
            timeout=6.0,
        )

        def update_clinical(current: Any) -> Any:
            current.clinical = updated
            return current

        await services.db.atomic_update_user_profile(
            context.session.user_id_hash,
            update_clinical,
        )
    except asyncio.TimeoutError:
        logger.info("Clinical extraction timed out for %s", context.request_id)
    except Exception:
        logger.warning("Clinical extraction failed for %s", context.request_id, exc_info=True)


async def mirror_usage_profile(
    *,
    services: Any,
    user_id_hash: str,
    usage: dict[str, int],
    clinical_mode: bool,
) -> None:
    """
    Synchronize usage metrics and credit counters onto user profile.
    """
    now = time.time()

    def update_profile(profile: Any) -> Any:
        profile.usage.total_credits_5h = int(usage.get("credits_5h", 0))
        profile.usage.total_credits_week = int(usage.get("credits_week", 0))
        profile.usage.total_messages_count = int(usage.get("total_messages", 0))
        profile.usage.credits_5h_reset_time = now + int(usage.get("reset_5h_seconds", 0)) - 5 * 3600
        profile.usage.credits_week_reset_time = now + int(usage.get("reset_week_seconds", 0)) - 7 * 24 * 3600
        if clinical_mode:
            profile.usage.pro_messages_count += 1
            profile.usage.pro_last_reset_time = profile.usage.credits_5h_reset_time
        return profile

    try:
        await services.db.atomic_update_user_profile(user_id_hash, update_profile)
    except Exception:
        logger.warning("Usage profile mirror failed for %s", user_id_hash, exc_info=True)


def convert_history(payload: ChatRequest) -> list[LLMMessage]:
    """
    Convert incoming payload message history into normalized LLMMessage domain list.
    """
    history: list[LLMMessage] = []
    for message in payload.history[-MAX_HISTORY_FOR_LLM:]:
        role = LLMRole.USER if message.role.value == "user" else LLMRole.ASSISTANT
        history.append(
            LLMMessage(
                role=role,
                content=message.content,
            )
        )
    return history


def resolve_locale(payload: ChatRequest, fallback_locale: str) -> str:
    """
    Resolve active request locale with fallback options.
    """
    if payload.metadata.locale and payload.metadata.locale != "auto":
        return payload.metadata.locale
    return fallback_locale or "auto"


def safety_view(decision: SafetyDecision) -> ChatSafetyView:
    """
    Construct user-visible ChatSafetyView model from SafetyDecision.
    """
    return ChatSafetyView(
        level=decision.level,
        bypass_llm=decision.bypass_llm,
        matched_rules=decision.matched_rules,
        user_visible_category=decision.user_visible_category,
    )


def provider_label(provider_used: str, *, rewrite_provider: str | None) -> str:
    """
    Format provider label string including optional query rewrite metadata.
    """
    base = sanitize_text(provider_used or "unknown", 80)
    if rewrite_provider:
        rewrite = sanitize_text(rewrite_provider, 80)
        return f"{base}+rewrite:{rewrite}"
    return base


def _history_includes_current_user_message(payload: ChatRequest, history: Sequence[Any]) -> bool:
    if not history:
        return False
    last = history[-1]
    if _history_role(last) != "user":
        return False
    latest_history_text = sanitize_text(_history_content(last), 2_000).strip()
    current_text = sanitize_text(payload.message or "", 2_000).strip()
    return bool(latest_history_text and current_text and latest_history_text == current_text)


def _history_role(item: Any) -> str:
    role = getattr(item, "role", "")
    value = getattr(role, "value", role)
    raw = sanitize_text(str(value or ""), 80).lower()
    match raw:
        case "user" | "human":
            return "user"
        case "assistant" | "mindpal" | "bot":
            return "assistant"
        case _:
            return raw


def _history_content(item: Any) -> str:
    for attr in ("content", "text", "message"):
        value = getattr(item, attr, None)
        if value:
            return str(value)
    return ""


def _looks_like_chat_count_question(lowered: str, original: str) -> bool:
    english_hits = (
        "how many messages" in lowered
        or "message count" in lowered
        or "messages in this chat" in lowered
        or "messages were sent" in lowered
        or "messages was been sent" in lowered
        or "how many have i sent" in lowered
        or "how many did i send" in lowered
        or "how many messages did i send" in lowered
        or "how many messages have i sent" in lowered
    )
    arabic_hits = any(
        phrase in original
        for phrase in (
            "كم رسالة",
            "كام رسالة",
            "عدد الرسائل",
            "عدد رسايل",
            "كام مسج",
            "كم مسج",
            "في الشات ده",
            "فى الشات ده",
        )
    )
    return bool(english_hits or arabic_hits)


def _asks_user_message_count(lowered: str, original: str) -> bool:
    return bool(
        "did i send" in lowered
        or "have i sent" in lowered
        or "i sent" in lowered
        or "from me" in lowered
        or "رسائلي" in original
        or "انا بعت" in original
        or "أنا بعت" in original
        or "مني" in original
        or "منّي" in original
    )


def _asks_assistant_message_count(lowered: str, original: str) -> bool:
    return bool(
        "did you send" in lowered
        or "have you sent" in lowered
        or "from you" in lowered
        or "mindpal sent" in lowered
        or "رديت" in original
        or "انت بعت" in original
        or "إنت بعت" in original
        or "من MindPal" in original
    )


def _contains_arabic_text(value: str) -> bool:
    return bool(value and ARABIC_CHAR_PATTERN.search(value))
