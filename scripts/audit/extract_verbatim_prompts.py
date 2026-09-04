# scripts/audit/extract_verbatim_prompts.py

import json
from pathlib import Path
from backend.models.chat import ChatMessage
from backend.models.user import UserProfile, UserPreferences, ClinicalProfile
from backend.services.domain.llm.message_classifier import MessageClassification
from backend.services.domain.llm.prompts.prompt_builder import build_tiered_prompt
from backend.services.domain.llm.chat_orchestrator import build_user_preferences_prompt

def extract_full_assembled_prompt(persona_file: str, history_window: int = 5) -> str:
    path = Path(persona_file)
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    persona_name = data["persona"]
    profile_data = data["profile"]

    profile = UserProfile(
        user_id_hash=profile_data["user_id_hash"],
        preferences=UserPreferences(**profile_data["preferences"]),
        clinical=ClinicalProfile(**profile_data["clinical"]) if "clinical" in profile_data else ClinicalProfile()
    )

    user_prefs_prompt = build_user_preferences_prompt(profile)
    memory_prompt = data["memory_summary"]["summary"]
    user_snapshot_str = json.dumps(data["user_snapshot"], ensure_ascii=False)

    classification = MessageClassification(
        tier="emotional",
        language="arabic" if persona_name == "bilingual" else "english",
        confidence=0.9,
        signals=("emotional_markers",),
        skip_thought=False,
        max_thought_words=200,
        max_response_tokens=1200,
        temperature=0.4
    )

    system_prompt = build_tiered_prompt(
        classification=classification,
        locale="ar" if persona_name == "bilingual" else "en",
        response_mode="normal_support",
        safety_level="safe",
        channel="web",
        clinical_mode=False,
        memory_prompt=f"{memory_prompt}\n\nUser Context Snapshot:\n{user_snapshot_str}",
        user_preferences=user_prefs_prompt,
    )

    all_history = data["history"]
    # Find the latest user message
    user_msgs = [m for m in all_history if m["role"] == "user"]
    latest_user_message = user_msgs[-1]["content"] if user_msgs else "Hello"

    # History window preceding the latest user message
    preceding_history = [m for m in all_history if m["content"] != latest_user_message][-history_window:]

    history_str_list = [f"<{m['role'].upper()}>: {m['content']}" for m in preceding_history]
    formatted_history = "\n".join(history_str_list)

    full_assembled = (
        f"=== [SYSTEM PROMPT] ===\n{system_prompt}\n\n"
        f"=== [CONVERSATION HISTORY ({len(preceding_history)} turns)] ===\n{formatted_history}\n\n"
        f"=== [CURRENT USER MESSAGE] ===\n<USER>: {latest_user_message}"
    )

    return full_assembled

if __name__ == "__main__":
    print("================================================================================")
    print("                       DISTRESSED PERSONA FULL ASSEMBLED PROMPT")
    print("================================================================================")
    print(extract_full_assembled_prompt("data/audit_fixtures/distressed_persona.json", history_window=5))
    print("\n" + "="*80 + "\n")
    print("================================================================================")
    print("                        SPORADIC PERSONA FULL ASSEMBLED PROMPT")
    print("================================================================================")
    print(extract_full_assembled_prompt("data/audit_fixtures/sporadic_persona.json", history_window=5))
