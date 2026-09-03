# scripts/audit/profile_llm_tokens.py

import json
import argparse
from pathlib import Path
from typing import Any
import tiktoken

from backend.models.chat import ChatMessage, ChatRequest, ChatMetadata
from backend.models.user import UserProfile, UserPreferences
from backend.services.domain.llm.message_classifier import MessageClassification
from backend.services.domain.llm.prompts.prompt_builder import build_tiered_prompt
from backend.services.domain.llm.chat_orchestrator import build_user_preferences_prompt

# Use cl100k_base tokenizer (standard for GPT-4 / Claude / Gemini approximations)
tokenizer = tiktoken.get_encoding("cl100k_base")

def count_tokens(text: str) -> int:
    if not text:
        return 0
    return len(tokenizer.encode(text))

def profile_persona(fixture_path: Path, windows: list[int]) -> dict[str, Any]:
    with open(fixture_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    persona_name = data["persona"]
    profile_data = data["profile"]

    # Construct UserProfile
    profile = UserProfile(
        user_id_hash=profile_data["user_id_hash"],
        preferences=UserPreferences(**profile_data["preferences"])
    )
    if "clinical" in profile_data:
        from backend.models.user import ClinicalProfile
        profile.clinical = ClinicalProfile(**profile_data["clinical"])

    # Injected components
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

    results_by_window = {}

    for w in windows:
        raw_history = data["history"][-w:]
        history_objs = [ChatMessage(role=m["role"], content=m["content"]) for m in raw_history]

        # System prompt token count breakdown
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

        # Token breakdown per component
        time_context_tokens = count_tokens("Temporal context:\nCurrent UTC time: Tuesday, 2026-09-01 12:00 UTC")
        identity_tokens = count_tokens("You are MindPal.")
        clear_contract_tokens = count_tokens("CLEAR RESPONSE CONTRACT:\nC — Capture...\nL — Lead...")
        user_prefs_tokens = count_tokens(user_prefs_prompt)
        memory_summary_tokens = count_tokens(memory_prompt)
        snapshot_tokens = count_tokens(user_snapshot_str)

        # History tokens
        history_tokens = sum(count_tokens(m["content"]) for m in raw_history)

        total_prompt_tokens = count_tokens(system_prompt) + history_tokens

        results_by_window[w] = {
            "window_size": w,
            "system_prompt_total_tokens": count_tokens(system_prompt),
            "history_tokens": history_tokens,
            "grand_total_input_tokens": total_prompt_tokens,
            "component_breakdown": {
                "user_preferences_tokens": user_prefs_tokens,
                "memory_summary_tokens": memory_summary_tokens,
                "user_snapshot_tokens": snapshot_tokens,
            }
        }

    return {
        "persona": persona_name,
        "windows": results_by_window
    }

def main():
    parser = argparse.ArgumentParser(description="Profile MindPal Token Usage across Personas and History Windows")
    parser.add_argument("--fixtures-dir", type=str, default="data/audit_fixtures")
    parser.add_argument("--windows", nargs="+", type=int, default=[5, 20, 50, 300])
    args = parser.parse_args()

    fixtures_path = Path(args.fixtures_dir)
    results = {}

    for fixture_file in sorted(fixtures_path.glob("*_persona.json")):
        res = profile_persona(fixture_file, args.windows)
        results[res["persona"]] = res["windows"]

    print(json.dumps(results, indent=2, ensure_ascii=False))

    out_file = Path("data/audit_fixtures/llm_token_profiling_results.json")
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    print(f"\nSaved token profiling results to {out_file}")

if __name__ == "__main__":
    main()
