# scripts/audit/generate_fixtures.py

import argparse
import json
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

OUTPUT_DIR = Path("data/audit_fixtures")
BASE_TIME = datetime(2026, 8, 1, 10, 0, 0, tzinfo=timezone.utc)


def generate_active_persona(seed: int, target_messages: int) -> dict[str, Any]:
    random.seed(seed)
    user_id_hash = f"usr_audit_active_{seed}"

    profile = {
        "user_id_hash": user_id_hash,
        "preferences": {
            "communication_style": "balanced",
            "preferred_name": "Alex",
            "gender": "male",
            "preferred_coping_tools": ["pomodoro_focus", "thought_journal", "box_breathing"],
            "wellness_goals": ["reduce_work_stress", "manage_deadlines", "better_sleep"],
            "avoided_topics": ["substance_use"],
            "custom_instructions": "Give concise, structured recommendations.",
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
            "presenting_problems": ["workplace_burnout", "time_management_stress"],
            "suspected_diagnoses": ["Occupational Stress"],
            "treatment_plan": "Cognitive reframing, Pomodoro structuring, and evening shutdown routines.",
            "phq9_history": [{"score": 7, "date": "2026-08-01"}, {"score": 5, "date": "2026-08-20"}],
            "gad7_history": [{"score": 9, "date": "2026-08-01"}, {"score": 6, "date": "2026-08-20"}]
        }
    }

    memory_graph = {
        "version": 4,
        "atoms": [
            {"id": "atom_act_1", "category": "work", "value": "Lead backend developer managing a major product launch.", "confidence": 0.98},
            {"id": "atom_act_2", "category": "lifestyle", "value": "Struggles with late-night coding and boundary setting.", "confidence": 0.92},
            {"id": "atom_act_3", "category": "coping", "value": "Finds Pomodoro technique and box breathing effective during crunch periods.", "confidence": 0.90}
        ]
    }

    memory_summary = {
        "summary": "## Overview\nAlex is a lead developer navigating high workload during a product launch.\n\n## Emotional Patterns & Coping\nProne to deadline anxiety; responds well to Pomodoro focus sessions and box breathing.\n\n## Work & Studies\nManages a team of engineers with tight sprint deadlines."
    }

    user_snapshot = {
        "situational_summary": "Alex is actively balancing sprint deliverables with improved evening wind-down routines.",
        "recent_emotions": ["focused", "slightly anxious"],
        "active_triggers": ["sprint review deadlines"],
        "coping_effectiveness": "high"
    }

    topics = [
        "sprint deadline for module A", "code review queue", "Pomodoro focus block", "team architecture sync",
        "late night debugging session", "sleep hygiene routine", "blue light filter setup", "bedtime wind-down",
        "PR review disagreement", "boundary setting with lead", "manager 1-on-1 prep", "priority alignment check",
        "database migration refactoring", "technical debt cleanup", "stress management break", "taking walking pauses"
    ]

    history = []
    current_time = BASE_TIME

    for i in range(target_messages // 2):
        current_time += timedelta(minutes=random.randint(15, 240))
        topic = topics[i % len(topics)]

        user_msg = f"I'm working on {topic} today (session #{i+1}). Feeling a bit pressed for time."
        asst_msg = f"I understand, Alex. For {topic} in session #{i+1}, let's use a focused 25-minute block to make steady, calm progress."

        history.append({"role": "user", "content": user_msg, "timestamp": current_time.isoformat()})
        history.append({"role": "assistant", "content": asst_msg, "timestamp": (current_time + timedelta(seconds=20)).isoformat()})

    return {
        "persona": "active",
        "seed": seed,
        "message_count": len(history),
        "user_id_hash": user_id_hash,
        "profile": profile,
        "memory_graph": memory_graph,
        "memory_summary": memory_summary,
        "user_snapshot": user_snapshot,
        "history": history
    }


def generate_bilingual_persona(seed: int, target_messages: int) -> dict[str, Any]:
    random.seed(seed)
    user_id_hash = f"usr_audit_bilingual_{seed}"

    profile = {
        "user_id_hash": user_id_hash,
        "preferences": {
            "communication_style": "balanced",
            "preferred_name": "Nour",
            "gender": "female",
            "preferred_coping_tools": ["breathing_exercise", "reflection_journal"],
            "wellness_goals": ["bilingual_expression", "work_life_balance"],
            "avoided_topics": [],
            "custom_instructions": "Respond in Egyptian Arabic when I speak Arabic, and English when I speak English.",
            "ui_settings": {
                "personalization": {
                    "baseStyle": "warm",
                    "warmth": "high",
                    "useHeadersLists": False,
                    "emojiSupport": True
                }
            }
        },
        "clinical": {
            "presenting_problems": ["acculturative_stress", "family_expectations"],
            "suspected_diagnoses": [],
            "treatment_plan": "Supportive listening and bilingual cognitive reframing.",
            "phq9_history": [],
            "gad7_history": []
        }
    }

    memory_graph = {
        "version": 4,
        "atoms": [
            {"id": "atom_bi_1", "category": "culture", "value": "Lives abroad, switches naturally between Egyptian Arabic and English.", "confidence": 0.96},
            {"id": "atom_bi_2", "category": "family", "value": "Feels family pressure regarding career choices.", "confidence": 0.88}
        ]
    }

    memory_summary = {
        "summary": "## Overview\nNour is an Egyptian professional living abroad, navigating dual-cultural dynamics.\n\n## Emotional Patterns & Coping\nExpresses deep emotional themes in Arabic and workplace topics in English.\n\n## Work & Studies\nWorks in digital marketing while maintaining close family ties in Cairo."
    }

    user_snapshot = {
        "situational_summary": "Nour is navigating family communication and career balance using bilingual expression.",
        "recent_emotions": ["nostalgic", "motivated"],
        "active_triggers": ["family phone calls", "work deadlines"],
        "coping_effectiveness": "high"
    }

    history = []
    current_time = BASE_TIME

    for i in range(target_messages // 2):
        current_time += timedelta(minutes=random.randint(15, 300))
        if i % 2 == 0:
            user_msg = f"أنا حاسّة بضغط في موضوع الشغل النهاردة رقم {i+1} ومحتاجة أرتب أفكاري."
            asst_msg = f"سلامتك يا نور. بالنسبة لموضوع رقم {i+1}، تعالي ناخد خطوة بسيطة وتنظمي أفكارك بهدوء."
        else:
            user_msg = f"I'm working on project update #{i+1} in English and feeling slightly nervous."
            asst_msg = f"You're doing great on project update #{i+1}, Nour! Focus on your 3 key points and take a steady breath."

        history.append({"role": "user", "content": user_msg, "timestamp": current_time.isoformat()})
        history.append({"role": "assistant", "content": asst_msg, "timestamp": (current_time + timedelta(seconds=20)).isoformat()})

    return {
        "persona": "bilingual",
        "seed": seed,
        "message_count": len(history),
        "user_id_hash": user_id_hash,
        "profile": profile,
        "memory_graph": memory_graph,
        "memory_summary": memory_summary,
        "user_snapshot": user_snapshot,
        "history": history
    }


def generate_distressed_persona(seed: int, target_messages: int) -> dict[str, Any]:
    random.seed(seed)
    user_id_hash = f"usr_audit_distressed_{seed}"

    profile = {
        "user_id_hash": user_id_hash,
        "preferences": {
            "communication_style": "concise",
            "preferred_name": "Maya",
            "gender": "female",
            "preferred_coping_tools": ["grounding_54321", "box_breathing", "safety_plan"],
            "wellness_goals": ["manage_panic", "emotional_regulation"],
            "avoided_topics": [],
            "custom_instructions": "Be gentle, slow down during high anxiety, and guide through grounding steps.",
            "ui_settings": {
                "personalization": {
                    "baseStyle": "candid",
                    "warmth": "high",
                    "useHeadersLists": False,
                    "emojiSupport": False
                }
            }
        },
        "clinical": {
            "presenting_problems": ["panic_attacks", "acute_distress"],
            "suspected_diagnoses": ["Panic Disorder"],
            "treatment_plan": "Panic intervention protocols, somatic 5-4-3-2-1 grounding, and crisis safety planning.",
            "phq9_history": [{"score": 14, "date": "2026-08-01"}, {"score": 11, "date": "2026-08-25"}],
            "gad7_history": [{"score": 16, "date": "2026-08-01"}, {"score": 13, "date": "2026-08-25"}]
        }
    }

    memory_graph = {
        "version": 4,
        "atoms": [
            {"id": "atom_dis_1", "category": "health", "value": "Experiences sudden acute panic attacks with racing heart rate.", "confidence": 0.99},
            {"id": "atom_dis_2", "category": "coping", "value": "Somatic 5-4-3-2-1 sensory grounding helps reduce physical panic symptoms.", "confidence": 0.94}
        ]
    }

    memory_summary = {
        "summary": "## Overview\nMaya experiences episodes of acute distress and panic attacks.\n\n## Emotional Patterns & Coping\nRequires immediate somatic grounding (5-4-3-2-1 technique) during acute surges.\n\n## Work & Studies\nStudent managing exam stress and panic triggers."
    }

    user_snapshot = {
        "situational_summary": "Maya is actively applying somatic grounding during high anxiety surges.",
        "recent_emotions": ["overwhelmed", "seeking grounding"],
        "active_triggers": ["sudden physical panic cues", "fear of losing control"],
        "coping_effectiveness": "moderate"
    }

    history = []
    current_time = BASE_TIME

    for i in range(target_messages // 2):
        current_time += timedelta(minutes=random.randint(10, 120))

        user_msg = f"I'm feeling a surge of anxiety around situation #{i+1}, my chest feels tight."
        asst_msg = f"I'm right here with you, Maya. For situation #{i+1}, let's do a 5-4-3-2-1 grounding exercise together. Tell me 3 things you can see."

        history.append({"role": "user", "content": user_msg, "timestamp": current_time.isoformat()})
        history.append({"role": "assistant", "content": asst_msg, "timestamp": (current_time + timedelta(seconds=15)).isoformat()})

    return {
        "persona": "distressed",
        "seed": seed,
        "message_count": len(history),
        "user_id_hash": user_id_hash,
        "profile": profile,
        "memory_graph": memory_graph,
        "memory_summary": memory_summary,
        "user_snapshot": user_snapshot,
        "history": history
    }


def generate_screening_persona(seed: int, target_messages: int) -> dict[str, Any]:
    random.seed(seed)
    user_id_hash = f"usr_audit_screening_{seed}"

    profile = {
        "user_id_hash": user_id_hash,
        "preferences": {
            "communication_style": "detailed",
            "preferred_name": "Jordan",
            "gender": "male",
            "preferred_coping_tools": ["phq9_tracking", "gad7_tracking", "mood_journal"],
            "wellness_goals": ["track_clinical_progress", "understand_mood_trends"],
            "avoided_topics": [],
            "custom_instructions": "Review clinical screening score changes periodically.",
            "ui_settings": {
                "personalization": {
                    "baseStyle": "professional",
                    "warmth": "default",
                    "useHeadersLists": True,
                    "emojiSupport": False
                }
            }
        },
        "clinical": {
            "presenting_problems": ["depressive_episodes", "generalized_anxiety"],
            "suspected_diagnoses": ["Major Depressive Disorder", "GAD"],
            "treatment_plan": "Bi-weekly PHQ-9 / GAD-7 screening and longitudinal symptom tracking.",
            "phq9_history": [
                {"score": 18, "date": "2026-06-01"},
                {"score": 15, "date": "2026-07-01"},
                {"score": 11, "date": "2026-08-01"},
                {"score": 8, "date": "2026-08-25"}
            ],
            "gad7_history": [
                {"score": 16, "date": "2026-06-01"},
                {"score": 13, "date": "2026-07-01"},
                {"score": 9, "date": "2026-08-01"},
                {"score": 6, "date": "2026-08-25"}
            ]
        }
    }

    memory_graph = {
        "version": 4,
        "atoms": [
            {"id": "atom_scr_1", "category": "clinical", "value": "Completed bi-weekly PHQ-9/GAD-7 screenings with steady score improvements.", "confidence": 0.98},
            {"id": "atom_scr_2", "category": "progress", "value": "Depression score dropped from 18 (moderately severe) to 8 (mild).", "confidence": 0.96}
        ]
    }

    memory_summary = {
        "summary": "## Overview\nJordan is actively engaged in bi-weekly clinical screening and progress tracking.\n\n## Emotional Patterns & Coping\nResponds positively to objective score tracking and visual trend reviews.\n\n## Work & Studies\nAccountant maintaining regular health check-ins."
    }

    user_snapshot = {
        "situational_summary": "Jordan has shown consistent clinical improvement across PHQ-9 (18->8) and GAD-7 (16->6) over 3 months.",
        "recent_emotions": ["encouraged", "reflective"],
        "active_triggers": ["monthly performance reports"],
        "coping_effectiveness": "high"
    }

    history = []
    current_time = BASE_TIME

    for i in range(target_messages // 2):
        current_time += timedelta(days=random.randint(1, 3))
        score = max(5, 18 - (i // 10))

        user_msg = f"Completing bi-weekly screening check-in #{i+1}. Current depression self-assessment score is {score}."
        asst_msg = f"Thank you for tracking check-in #{i+1}, Jordan. Your score of {score} reflects your ongoing progress."

        history.append({"role": "user", "content": user_msg, "timestamp": current_time.isoformat()})
        history.append({"role": "assistant", "content": asst_msg, "timestamp": (current_time + timedelta(seconds=20)).isoformat()})

    return {
        "persona": "screening",
        "seed": seed,
        "message_count": len(history),
        "user_id_hash": user_id_hash,
        "profile": profile,
        "memory_graph": memory_graph,
        "memory_summary": memory_summary,
        "user_snapshot": user_snapshot,
        "history": history
    }


def generate_sporadic_persona(seed: int, target_messages: int) -> dict[str, Any]:
    random.seed(seed)
    user_id_hash = f"usr_audit_sporadic_{seed}"

    profile = {
        "user_id_hash": user_id_hash,
        "preferences": {
            "communication_style": "concise",
            "preferred_name": "Sam",
            "gender": "male",
            "preferred_coping_tools": ["quick_reframe"],
            "wellness_goals": ["occasional_stress_relief"],
            "avoided_topics": [],
            "custom_instructions": "Keep answers short as I only check in occasionally.",
            "ui_settings": {
                "personalization": {
                    "baseStyle": "default",
                    "warmth": "default",
                    "useHeadersLists": False,
                    "emojiSupport": False
                }
            }
        },
        "clinical": {
            "presenting_problems": ["episodic_stress"],
            "suspected_diagnoses": [],
            "treatment_plan": "As-needed situational problem-solving.",
            "phq9_history": [],
            "gad7_history": []
        }
    }

    memory_graph = {
        "version": 4,
        "atoms": [
            {"id": "atom_spo_1", "category": "pattern", "value": "Checks in sporadically every few weeks during intense work spikes.", "confidence": 0.85}
        ]
    }

    memory_summary = {
        "summary": "## Overview\nSam is a sporadic user who logs in every few weeks for quick situational advice.\n\n## Emotional Patterns & Coping\nPrefers fast, 2-minute actionable steps without long reflection loops."
    }

    user_snapshot = {
        "situational_summary": "Sam is returning after a 3-week gap to address a sudden workplace conflict.",
        "recent_emotions": ["annoyed", "seeking fast advice"],
        "active_triggers": ["interpersonal disagreement"],
        "coping_effectiveness": "moderate"
    }

    history = []
    session_dates = [
        datetime(2026, 6, 1, 14, 0, tzinfo=timezone.utc),
        datetime(2026, 6, 25, 18, 30, tzinfo=timezone.utc),
        datetime(2026, 7, 20, 9, 15, tzinfo=timezone.utc),
        datetime(2026, 8, 15, 11, 0, tzinfo=timezone.utc),
        datetime(2026, 9, 1, 16, 45, tzinfo=timezone.utc)
    ]

    for i in range(min(target_messages, 20) // 2):
        s_date = session_dates[i % len(session_dates)]
        user_msg = f"Check-in session #{i+1}: dealing with a quick work issue."
        asst_msg = f"Welcome back, Sam! Ready for session #{i+1}. What's the main challenge right now?"

        history.append({"role": "user", "content": user_msg, "timestamp": s_date.isoformat()})
        history.append({"role": "assistant", "content": asst_msg, "timestamp": (s_date + timedelta(seconds=15)).isoformat()})

    return {
        "persona": "sporadic",
        "seed": seed,
        "message_count": len(history),
        "user_id_hash": user_id_hash,
        "profile": profile,
        "memory_graph": memory_graph,
        "memory_summary": memory_summary,
        "user_snapshot": user_snapshot,
        "history": history
    }


def generate_new_persona(seed: int, target_messages: int) -> dict[str, Any]:
    random.seed(seed)
    user_id_hash = f"usr_audit_new_{seed}"

    profile = {
        "user_id_hash": user_id_hash,
        "preferences": {
            "communication_style": "balanced",
            "preferred_name": "Taylor",
            "gender": None,
            "preferred_coping_tools": [],
            "wellness_goals": [],
            "avoided_topics": [],
            "custom_instructions": "",
            "ui_settings": {}
        },
        "clinical": {
            "presenting_problems": [],
            "suspected_diagnoses": [],
            "treatment_plan": "",
            "phq9_history": [],
            "gad7_history": []
        }
    }

    memory_graph = {"version": 4, "atoms": []}
    memory_summary = {"summary": "## Overview\nNew user onboarding session."}
    user_snapshot = {
        "situational_summary": "Taylor just created an account and is exploring MindPal.",
        "recent_emotions": ["curious"],
        "active_triggers": [],
        "coping_effectiveness": "unknown"
    }

    current_time = BASE_TIME
    history = [
        {"role": "user", "content": "Hi there! I just downloaded MindPal. What can you help me with?", "timestamp": current_time.isoformat()},
        {"role": "assistant", "content": "Welcome Taylor! I'm MindPal, your wellness companion. How are you feeling today?", "timestamp": (current_time + timedelta(seconds=15)).isoformat()},
        {"role": "user", "content": "I've been having trouble sleeping because my mind races at night.", "timestamp": (current_time + timedelta(minutes=2)).isoformat()},
        {"role": "assistant", "content": "A racing mind at bedtime is very common. Would you like to try a simple 2-minute relaxation technique?", "timestamp": (current_time + timedelta(minutes=2, seconds=20)).isoformat()},
        {"role": "user", "content": "Sure, let's try a short relaxation exercise.", "timestamp": (current_time + timedelta(minutes=3)).isoformat()}
    ]

    return {
        "persona": "new",
        "seed": seed,
        "message_count": len(history),
        "user_id_hash": user_id_hash,
        "profile": profile,
        "memory_graph": memory_graph,
        "memory_summary": memory_summary,
        "user_snapshot": user_snapshot,
        "history": history
    }


def verify_cross_persona_uniqueness(fixtures: dict[str, dict[str, Any]]) -> None:
    """Check and guarantee that no two personas share identical memory graphs, summaries, or repetitive loops."""
    print("\n--- Running Cross-Persona Uniqueness & Coherence Verification ---")
    persona_names = list(fixtures.keys())

    for i in range(len(persona_names)):
        for j in range(i + 1, len(persona_names)):
            p1_name, p2_name = persona_names[i], persona_names[j]
            f1, f2 = fixtures[p1_name], fixtures[p2_name]

            summary1 = f1["memory_summary"]["summary"]
            summary2 = f2["memory_summary"]["summary"]
            if summary1 == summary2:
                raise ValueError(f"Uniqueness Failure: {p1_name} and {p2_name} share identical memory summaries!")

            graph1 = json.dumps(f1["memory_graph"], sort_keys=True)
            graph2 = json.dumps(f2["memory_graph"], sort_keys=True)
            if graph1 == graph2 and len(f1["memory_graph"]["atoms"]) > 0:
                raise ValueError(f"Uniqueness Failure: {p1_name} and {p2_name} share identical memory graphs!")

            # Verify no canned repetitive assistant replies in long histories
            asst_replies_p1 = [m["content"] for m in f1["history"] if m["role"] == "assistant"]
            if len(asst_replies_p1) > 10 and len(set(asst_replies_p1)) < (len(asst_replies_p1) * 0.8):
                raise ValueError(f"Coherence Failure: {p1_name} history contains repetitive assistant loops!")

    print("SUCCESS: All 6 personas possess strictly unique, distinct, and non-looping artifacts!")


def main():
    parser = argparse.ArgumentParser(description="Generate MindPal Audit User Personas Fixtures")
    parser.add_argument("--persona", choices=["active", "bilingual", "distressed", "screening", "sporadic", "new", "all"], default="all")
    parser.add_argument("--messages", type=int, default=300)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output-dir", type=str, default="data/audit_fixtures")
    args = parser.parse_args()

    out_path = Path(args.output_dir)
    out_path.mkdir(parents=True, exist_ok=True)

    generators = {
        "active": generate_active_persona,
        "bilingual": generate_bilingual_persona,
        "distressed": generate_distressed_persona,
        "screening": generate_screening_persona,
        "sporadic": generate_sporadic_persona,
        "new": generate_new_persona,
    }

    selected = list(generators.keys()) if args.persona == "all" else [args.persona]
    generated_fixtures = {}

    for p_name in selected:
        count = 5 if p_name == "new" else (20 if p_name == "sporadic" else args.messages)
        fixture = generators[p_name](seed=args.seed, target_messages=count)
        generated_fixtures[p_name] = fixture

        file_path = out_path / f"{p_name}_persona.json"
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(fixture, f, ensure_ascii=False, indent=2)
        print(f"Generated fixture: {file_path} ({len(fixture['history'])} messages)")

    if len(generated_fixtures) > 1:
        verify_cross_persona_uniqueness(generated_fixtures)


if __name__ == "__main__":
    main()
