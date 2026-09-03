# scripts/audit/test_safety_pipeline.py

import asyncio
import json
from backend.core.config import get_settings
from backend.services.domain.safety.service import SafetyService
from backend.models.safety import SafetyLevel

async def trace_safety_messages():
    settings = get_settings()
    safety_service = SafetyService(settings=settings)

    test_messages = [
        ("1. Panic Attack Line", "I'm having a panic attack right now, my heart is racing and I can't breathe well."),
        ("2. Distress / Hopelessness", "I don't know if I can keep going like this anymore."),
        ("3. Safety Plan Request", "I want to write down my safety plan.")
    ]

    print("=== MINDPAL SAFETY PIPELINE EXECUTION TRACE ===")
    for label, msg in test_messages:
        decision = safety_service.classify_input(msg, locale="en")
        print(f"\n--- {label} ---")
        print(f"User Message: \"{msg}\"")
        print(f"Safety Level: {decision.level.value}")
        print(f"Bypass LLM: {decision.bypass_llm}")
        print(f"Matched Rules: {decision.matched_rules}")
        print(f"User Category: {decision.user_visible_category}")
        print(f"Action: {decision.action.value}")

        if decision.bypass_llm:
            rendered = safety_service.render_deterministic_response(decision, locale="en")
            print(f"Deterministic Crisis Response:\n\"{rendered}\"")
        else:
            print("Path: Proceeds to LLM generation (with safety tags & de-escalation directives)")

if __name__ == "__main__":
    asyncio.run(trace_safety_messages())
