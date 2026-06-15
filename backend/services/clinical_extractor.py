# backend/services/clinical_extractor.py

import json
import logging
import uuid
from datetime import datetime, UTC
from collections.abc import Sequence

from backend.models.chat import LLMMessage
from backend.models.user import ClinicalProfile, ClinicalScore
from backend.services.llm_service import LLMService, build_llm_request

logger = logging.getLogger(__name__)

CLINICAL_EXTRACTION_PROMPT = """You are an expert clinical data extractor. Your task is to analyze the recent conversation between an AI therapist (MindPal Pro) and a patient, and update the patient's clinical chart.
Output ONLY a valid JSON object matching this schema. Do NOT wrap it in ```json blocks or include any markdown formatting.

{
    "presenting_problems": ["string", "string"], // Up to 10 current presenting problems identified.
    "suspected_diagnoses": ["string"], // Up to 10 suspected diagnoses.
    "treatment_plan": "string", // A short 1-2 sentence treatment plan or current strategy.
    "phq9_score": number, // Estimated PHQ-9 depression severity score (0-27) based on conversation. 0 if none.
    "gad7_score": number // Estimated GAD-7 anxiety severity score (0-21) based on conversation. 0 if none.
}

If no clinical symptoms are present, return empty arrays and 0 for the scores.
"""

async def extract_clinical_profile(
    llm: LLMService,
    messages: Sequence[LLMMessage],
    current_profile: ClinicalProfile
) -> ClinicalProfile:
    """
    Analyzes the conversation and returns an updated ClinicalProfile.
    """
    if not messages:
        return current_profile

    # Build the prompt
    history_text = "\n".join(
        f"{msg.role}: {msg.content}" for msg in messages[-10:]  # Only analyze last 10 messages
    )
    
    user_prompt = f"Current Profile:\n{current_profile.model_dump_json()}\n\nRecent Conversation:\n{history_text}"

    request = build_llm_request(
        request_id=f"clinical_extraction_{uuid.uuid4().hex[:12]}",
        system_prompt=CLINICAL_EXTRACTION_PROMPT,
        user_message=user_prompt,
        temperature=0.0,
        max_output_tokens=500,
    )

    try:
        response = await llm.generate(request)
        raw_text = response.text.strip()
        
        # Clean up any potential markdown formatting
        if raw_text.startswith("```json"):
            raw_text = raw_text[7:]
        if raw_text.startswith("```"):
            raw_text = raw_text[3:]
        if raw_text.endswith("```"):
            raw_text = raw_text[:-3]
            
        data = json.loads(raw_text.strip())
        
        # Update current profile
        if "presenting_problems" in data:
            current_profile.presenting_problems = data["presenting_problems"][:10]
        if "suspected_diagnoses" in data:
            current_profile.suspected_diagnoses = data["suspected_diagnoses"][:10]
        if "treatment_plan" in data:
            current_profile.treatment_plan = data["treatment_plan"]
            
        today_str = datetime.now(UTC).strftime("%Y-%m-%d")
        
        if "phq9_score" in data and isinstance(data["phq9_score"], (int, float)):
            score = int(data["phq9_score"])
            if score > 0 or not current_profile.phq9_history:
                current_profile.phq9_history.append(ClinicalScore(date=today_str, score=score))
                
        if "gad7_score" in data and isinstance(data["gad7_score"], (int, float)):
            score = int(data["gad7_score"])
            if score > 0 or not current_profile.gad7_history:
                current_profile.gad7_history.append(ClinicalScore(date=today_str, score=score))
                
        # Keep history length manageable
        current_profile.phq9_history = current_profile.phq9_history[-10:]
        current_profile.gad7_history = current_profile.gad7_history[-10:]
        
        return current_profile
        
    except Exception as e:
        logger.error(f"Failed to extract clinical profile: {e}")
        return current_profile
