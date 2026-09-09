# backend/services/domain/llm/reply_strategy_engine.py

"""
Reply Strategy Engine and Session FSM.

Selects from 10+ situation-specific strategy variants based on session state
and user history, filling prompt template slots from user state and logging strategy_used.
"""

from __future__ import annotations

from enum import Enum


class SessionState(str, Enum):
    GREET = "GREET"
    ASSESS = "ASSESS"
    EXPLORE = "EXPLORE"
    INTERVENE = "INTERVENE"
    CONSOLIDATE = "CONSOLIDATE"
    CLOSE = "CLOSE"


class ReplyStrategy(str, Enum):
    GROUNDED_VALIDATION = "grounded_validation"
    SOCRATIC_EXPLORATION = "socratic_exploration"
    GUIDED_COPING = "guided_coping"
    REFRAME_THOUGHT = "reframe_thought"
    ACTION_PLANNING = "action_planning"
    REFLECTIVE_SUMMARY = "reflective_summary"
    GENTLE_CLOSING = "gentle_closing"
    EMPATHIC_PRESENCE = "empathic_presence"
    COGNITIVE_RESTRUCTURING = "cognitive_restructuring"
    DEESCALATE_GROUND = "deescalate_ground"
    INFORMATIONAL_WELLNESS = "informational_wellness"


STRATEGY_TEMPLATES: dict[ReplyStrategy, str] = {
    ReplyStrategy.GROUNDED_VALIDATION: (
        "Strategy: Grounded Validation\n"
        "Validate the user's emotion directly without exaggeration or clinical jargon. "
        "Acknowledge the weight of {active_topic} calmly and invite one reflection."
    ),
    ReplyStrategy.SOCRATIC_EXPLORATION: (
        "Strategy: Socratic Exploration\n"
        "Ask one open-ended, non-judgmental question exploring {active_topic}. "
        "Help the user uncover their own insight without prescribing an immediate fix."
    ),
    ReplyStrategy.GUIDED_COPING: (
        "Strategy: Guided Coping\n"
        "Offer one concrete, low-effort coping technique (e.g. 5-4-3-2-1 grounding or box breathing) "
        "tailored to {active_topic}. Keep instructions short and step-by-step."
    ),
    ReplyStrategy.REFRAME_THOUGHT: (
        "Strategy: Cognitive Reframing\n"
        "Gently offer a plausible alternative perspective on {active_topic}. "
        "Frame it as 'one possibility' without invalidating their initial feeling."
    ),
    ReplyStrategy.ACTION_PLANNING: (
        "Strategy: Micro-Action Planning\n"
        "Help the user break down {active_topic} into one immediate 2-minute micro-step "
        "they can complete today."
    ),
    ReplyStrategy.REFLECTIVE_SUMMARY: (
        "Strategy: Reflective Summary\n"
        "Summarize key themes expressed regarding {active_topic} in 2 gentle sentences. "
        "Confirm understanding and ask if this resonates."
    ),
    ReplyStrategy.GENTLE_CLOSING: (
        "Strategy: Gentle Closing\n"
        "Warmly wrap up the current reflection on {active_topic}. "
        "Leave the door open for future support without forcing further questions."
    ),
    ReplyStrategy.EMPATHIC_PRESENCE: (
        "Strategy: Empathic Presence\n"
        "Provide warm, quiet emotional presence. Focus 100% on listening and validating "
        "their feelings around {active_topic} without pushing for solutions."
    ),
    ReplyStrategy.COGNITIVE_RESTRUCTURING: (
        "Strategy: Structured Cognitive Restructuring\n"
        "Identify the core cognitive distortion (e.g. catastrophizing) in {active_topic} "
        "and guide the user through testing the evidence for and against it."
    ),
    ReplyStrategy.DEESCALATE_GROUND: (
        "Strategy: De-escalation & Physical Grounding\n"
        "Provide immediate physical grounding instructions (feet on floor, slow exhale). "
        "Prioritize safety and calm presence."
    ),
    ReplyStrategy.INFORMATIONAL_WELLNESS: (
        "Strategy: Informational Wellness\n"
        "Provide clear, grounded educational information regarding {active_topic} "
        "while maintaining a supportive wellness boundary."
    ),
}


class SessionFSM:
    """Lightweight session state machine for conversational progression."""

    def __init__(self, initial_state: SessionState = SessionState.GREET) -> None:
        self.state = initial_state
        self.turn_count = 0

    def transition(self, turn_count: int, is_emotional: bool, user_wants_closing: bool = False) -> SessionState:
        self.turn_count = turn_count

        if user_wants_closing:
            self.state = SessionState.CLOSE
            return self.state

        if turn_count <= 1:
            self.state = SessionState.GREET
        elif turn_count <= 3:
            self.state = SessionState.ASSESS
        elif is_emotional:
            self.state = SessionState.EXPLORE if self.state != SessionState.INTERVENE else SessionState.INTERVENE
        elif turn_count > 10:
            self.state = SessionState.CONSOLIDATE
        else:
            self.state = SessionState.EXPLORE

        return self.state


class ReplyStrategyEngine:
    """Engine for selecting and filling strategy templates."""

    def select_strategy(
        self,
        fsm_state: SessionState,
        turn_count: int,
        is_crisis: bool = False,
        active_topic: str | None = None,
        last_strategy: ReplyStrategy | None = None,
    ) -> tuple[ReplyStrategy, str]:
        """
        Selects a strategy variant and fills template slots.
        Ensures zero identical consecutive strategies when choices exist.
        """
        if is_crisis:
            return ReplyStrategy.DEESCALATE_GROUND, "Crisis path: deterministic response override."

        topic_str = active_topic or "their situation"

        # Candidate mapping by FSM state
        candidate_map: dict[SessionState, list[ReplyStrategy]] = {
            SessionState.GREET: [ReplyStrategy.GROUNDED_VALIDATION, ReplyStrategy.EMPATHIC_PRESENCE],
            SessionState.ASSESS: [ReplyStrategy.SOCRATIC_EXPLORATION, ReplyStrategy.EMPATHIC_PRESENCE, ReplyStrategy.GROUNDED_VALIDATION],
            SessionState.EXPLORE: [ReplyStrategy.SOCRATIC_EXPLORATION, ReplyStrategy.REFRAME_THOUGHT, ReplyStrategy.COGNITIVE_RESTRUCTURING, ReplyStrategy.INFORMATIONAL_WELLNESS],
            SessionState.INTERVENE: [ReplyStrategy.GUIDED_COPING, ReplyStrategy.ACTION_PLANNING, ReplyStrategy.REFRAME_THOUGHT],
            SessionState.CONSOLIDATE: [ReplyStrategy.REFLECTIVE_SUMMARY, ReplyStrategy.ACTION_PLANNING, ReplyStrategy.GENTLE_CLOSING],
            SessionState.CLOSE: [ReplyStrategy.GENTLE_CLOSING, ReplyStrategy.REFLECTIVE_SUMMARY],
        }

        candidates = candidate_map.get(fsm_state, [ReplyStrategy.GROUNDED_VALIDATION])

        # Rotation logic: use turn_count offset to vary candidate selection dynamically across turns when last_strategy is omitted
        start_index = (max(0, turn_count - 1)) % len(candidates)
        ordered_candidates = candidates[start_index:] + candidates[:start_index]

        selected = ordered_candidates[0]
        for candidate in ordered_candidates:
            if candidate != last_strategy:
                selected = candidate
                break

        template = STRATEGY_TEMPLATES.get(selected, STRATEGY_TEMPLATES[ReplyStrategy.GROUNDED_VALIDATION])
        filled_prompt = template.format(active_topic=topic_str)

        return selected, filled_prompt
