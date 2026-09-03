# scripts/audit/generate_fixtures.py

import argparse
import json
import random
import os
from pathlib import Path
from typing import Any

OUTPUT_DIR = Path("data/audit_fixtures")

ARABIC_MESSAGES = [
    "أنا حاسس بضغط كبير من الشغل ومش عارف أنام كويس بليل.",
    "معلش يا مايندبال، ممكن تساعدني أظم وقتي أفضل؟",
    "Yesterday was really hard at work, but Today I feel a bit better.",
    "I'm feeling anxious about my presentation tomorrow.",
    "هل فيه تمارين تنفس معينة تقدر تنصحني بيها دلوقتي؟",
    "شكراً ليك، هجرب التمارين دي وأقولك النتيجة.",
    "Sometimes I feel overwhelmed by everything expected of me.",
    "كيف أتعامل مع مشاعر القلق المستمرة؟",
    "Today was okay, I managed to take a short walk in the evening.",
    "I'm trying to improve my daily routine step by step."
]

ENGLISH_MESSAGES = [
    "I've been feeling quite overwhelmed with work deadlines lately.",
    "Can you give me some quick coping mechanisms for workplace stress?",
    "That makes sense. What about sleep hygiene?",
    "I tried going to bed earlier, but my mind keeps racing.",
    "What should I do when I wake up at 3 AM worrying?",
    "Thanks, I will try the 4-7-8 breathing exercise tonight.",
    "How do I set better boundaries with my colleagues?",
    "I noticed I feel much better after talking through this.",
    "Can we review my goals for this week?",
    "I want to focus on mindfulness and daily journaling."
]

DISTRESSED_MESSAGES = [
    "I'm having a panic attack right now, my heart is racing and I can't breathe well.",
    "I feel completely hopeless and isolated from everyone.",
    "I don't know if I can keep going like this anymore.",
    "Everything feels too heavy today.",
    "Can you just stay with me and help me ground myself?",
    "I'm feeling a bit calmer now after doing the breathing step.",
    "It's scary when the anxiety hits so suddenly.",
    "What triggered this panic?",
    "I want to write down my safety plan.",
    "Thank you for being here with me."
]

def generate_persona(persona_name: str, message_count: int, seed: int = 42) -> dict[str, Any]:
    random.seed(seed)
    user_id_hash = f"usr_audit_{persona_name}_{seed}"

    profile: dict[str, Any] = {
        "user_id_hash": user_id_hash,
        "preferences": {
            "communication_style": "balanced",
            "preferred_name": persona_name.capitalize(),
            "gender": "female" if persona_name in ("bilingual", "distressed") else "male",
            "preferred_coping_tools": ["breathing_exercise", "grounding_54321", "journaling"],
            "wellness_goals": ["reduce_anxiety", "improve_sleep", "work_life_balance"],
            "avoided_topics": ["substance_use"],
            "custom_instructions": "Keep answers structured and practical.",
            "ui_settings": {
                "personalization": {
                    "baseStyle": "friendly",
                    "warmth": "high",
                    "useHeadersLists": True,
                    "emojiSupport": True
                }
            }
        },
        "clinical": {
            "presenting_problems": ["generalized_anxiety", "sleep_disturbance"],
            "suspected_diagnoses": ["GAD"],
            "treatment_plan": "Cognitive restructuring & daily relaxation techniques.",
            "phq9_history": [{"score": 12, "date": "2026-01-15"}, {"score": 9, "date": "2026-02-15"}],
            "gad7_history": [{"score": 14, "date": "2026-01-15"}, {"score": 11, "date": "2026-02-15"}]
        }
    }

    # Generate memory graph
    memory_graph = {
        "version": 4,
        "atoms": [
            {"id": "atom_1", "category": "work", "value": "Works as a software engineer with high workload.", "confidence": 0.95},
            {"id": "atom_2", "category": "health", "value": "Experiences anxiety and sleep difficulty.", "confidence": 0.9},
            {"id": "atom_3", "category": "preference", "value": "Prefers breathing exercises over meditation.", "confidence": 0.85}
        ]
    }

    # Generate memory summary
    memory_summary = {
        "summary": "## Overview\nUser is a software engineer dealing with stress and sleep anxiety.\n\n## Emotional Patterns & Coping\nResponds well to grounding exercises and breathing routines.\n\n## Work & Studies\nHigh workload with frequent tight deadlines."
    }

    # Generate user snapshot
    user_snapshot = {
        "situational_summary": f"User ({persona_name}) is currently tracking wellness goals with active chat engagement.",
        "recent_emotions": ["anxious", "hopeful"],
        "active_triggers": ["work deadlines"],
        "coping_effectiveness": "moderate"
    }

    # Generate message history
    history = []
    if persona_name == "bilingual":
        pool = ARABIC_MESSAGES
    elif persona_name == "distressed":
        pool = DISTRESSED_MESSAGES
    else:
        pool = ENGLISH_MESSAGES

    for i in range(message_count):
        role = "user" if i % 2 == 0 else "assistant"
        msg_text = pool[i % len(pool)] if role == "user" else f"I understand. Let's work through this step by step. (Turn {i+1})"
        history.append({
            "role": role,
            "content": msg_text
        })

    return {
        "persona": persona_name,
        "seed": seed,
        "message_count": len(history),
        "user_id_hash": user_id_hash,
        "profile": profile,
        "memory_graph": memory_graph,
        "memory_summary": memory_summary,
        "user_snapshot": user_snapshot,
        "history": history
    }

def main():
    parser = argparse.ArgumentParser(description="Generate MindPal Audit User Personas Fixtures")
    parser.add_argument("--persona", choices=["active", "bilingual", "distressed", "screening", "sporadic", "new", "all"], default="all")
    parser.add_argument("--messages", type=int, default=300)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output-dir", type=str, default="data/audit_fixtures")
    args = parser.parse_args()

    out_path = Path(args.output_dir)
    out_path.mkdir(parents=True, exist_ok=True)

    personas = ["active", "bilingual", "distressed", "screening", "sporadic", "new"] if args.persona == "all" else [args.persona]

    for p in personas:
        count = 5 if p == "new" else (20 if p == "sporadic" else args.messages)
        fixture = generate_persona(p, count, seed=args.seed)
        file_path = out_path / f"{p}_persona.json"
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(fixture, f, ensure_ascii=False, indent=2)
        print(f"Generated fixture: {file_path} ({count} messages)")

if __name__ == "__main__":
    main()
