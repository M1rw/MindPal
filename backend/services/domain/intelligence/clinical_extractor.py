# backend/services/domain/intelligence/clinical_extractor.py

from __future__ import annotations

import json
import logging
import re
import uuid
from collections.abc import Sequence
from datetime import UTC, datetime

from backend.models.chat import LLMMessage
from backend.models.user import ClinicalProfile, ClinicalScore
from backend.services.domain.llm.service import LLMService
from backend.services.domain.llm.request_builder import build_llm_request

logger = logging.getLogger(__name__)

MIN_EXTRACTION_CONTENT_LENGTH = 80

CLINICAL_EXTRACTION_PROMPT = """You are an expert clinical data extractor. Analyze the conversation between an AI therapist (MindPal Pro) and a patient, then update the patient's clinical chart.

Output ONLY a valid JSON object matching this schema. Do NOT wrap it in ```json blocks or markdown.

{
    "presenting_problems": ["string"],
    "suspected_diagnoses": ["string"],
    "treatment_plan": "string",
    "phq9_score": number,
    "gad7_score": number,
    "risk_level": "none|low|moderate|high",
    "therapeutic_progress": "string",
    "key_patterns": ["string"]
}

Field descriptions:
- presenting_problems: Up to 10 current presenting problems. Merge with existing, don't duplicate.
- suspected_diagnoses: Up to 10 suspected diagnoses based on DSM-5 criteria observed.
- treatment_plan: 1-2 sentence current treatment strategy.
- phq9_score: Estimated PHQ-9 (0-27) based on conversation indicators. 0 if no depression indicators.
- gad7_score: Estimated GAD-7 (0-21) based on conversation indicators. 0 if no anxiety indicators.
- risk_level: Overall risk assessment from this session.
- therapeutic_progress: Brief note on progress or regression observed.
- key_patterns: Up to 5 recurring behavioral/cognitive patterns identified.

If no clinical symptoms present, return empty arrays, 0 scores, and "none" risk level.
"""


class ClinicalExtractor:
    """Clinical extraction orchestrator."""

    def __init__(self, llm_service: LLMService) -> None:
        self.llm_service = llm_service

    async def extract(
        self,
        messages: Sequence[LLMMessage],
        current_profile: ClinicalProfile,
    ) -> ClinicalProfile:
        return await extract_clinical_profile(self.llm_service, messages, current_profile)


async def extract_clinical_profile(
    llm: LLMService,
    messages: Sequence[LLMMessage],
    current_profile: ClinicalProfile,
) -> ClinicalProfile:
    """
    Analyzes the conversation and returns an updated ClinicalProfile.
    """
    if not messages:
        return current_profile

    recent_messages = list(messages[-10:])
    total_content = sum(len(msg.content or "") for msg in recent_messages)
    if total_content < MIN_EXTRACTION_CONTENT_LENGTH:
        return current_profile

    history_text = "\n".join(
        f"{msg.role.value}: {msg.content}" for msg in recent_messages
    )

    user_prompt = f"Current Profile:\n{current_profile.model_dump_json()}\n\nRecent Conversation:\n{history_text}"

    request = build_llm_request(
        request_id=f"clinical_extraction_{uuid.uuid4().hex[:12]}",
        system_prompt=CLINICAL_EXTRACTION_PROMPT,
        user_message=user_prompt,
        temperature=0.0,
        max_output_tokens=600,
    )

    try:
        response = await llm.generate(request)
        raw_text = response.text.strip()

        match = re.search(r"\{.*\}", raw_text, re.DOTALL)
        if match:
            clean_json = match.group(0)
        else:
            clean_json = "{}"

        data = json.loads(clean_json)

        if "presenting_problems" in data and isinstance(data["presenting_problems"], list):
            existing = set(current_profile.presenting_problems)
            for prob in data["presenting_problems"][:10]:
                if isinstance(prob, str) and prob.strip():
                    existing.add(prob.strip())
            current_profile.presenting_problems = list(existing)[:10]

        if "suspected_diagnoses" in data and isinstance(data["suspected_diagnoses"], list):
            existing = set(current_profile.suspected_diagnoses)
            for diag in data["suspected_diagnoses"][:10]:
                if isinstance(diag, str) and diag.strip():
                    existing.add(diag.strip())
            current_profile.suspected_diagnoses = list(existing)[:10]

        if "treatment_plan" in data and isinstance(data["treatment_plan"], str):
            current_profile.treatment_plan = data["treatment_plan"][:500]

        today_str = datetime.now(UTC).strftime("%Y-%m-%d")

        if "phq9_score" in data and isinstance(data["phq9_score"], (int, float)):
            score = max(0, min(27, int(data["phq9_score"])))
            last_phq9 = current_profile.phq9_history[-1] if current_profile.phq9_history else None
            if not last_phq9 or last_phq9.date != today_str or last_phq9.score != score:
                if last_phq9 and last_phq9.date == today_str:
                    current_profile.phq9_history[-1] = ClinicalScore(date=today_str, score=score)
                elif score > 0 or not current_profile.phq9_history:
                    current_profile.phq9_history.append(ClinicalScore(date=today_str, score=score))

        if "gad7_score" in data and isinstance(data["gad7_score"], (int, float)):
            score = max(0, min(21, int(data["gad7_score"])))
            last_gad7 = current_profile.gad7_history[-1] if current_profile.gad7_history else None
            if not last_gad7 or last_gad7.date != today_str or last_gad7.score != score:
                if last_gad7 and last_gad7.date == today_str:
                    current_profile.gad7_history[-1] = ClinicalScore(date=today_str, score=score)
                elif score > 0 or not current_profile.gad7_history:
                    current_profile.gad7_history.append(ClinicalScore(date=today_str, score=score))

        current_profile.phq9_history = current_profile.phq9_history[-20:]
        current_profile.gad7_history = current_profile.gad7_history[-20:]

        return current_profile

    except Exception as e:
        logger.error("Failed to extract clinical profile: %s", e)
        return current_profile
