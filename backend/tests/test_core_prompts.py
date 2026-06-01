from backend.core.prompts import build_system_prompt

def test_build_system_prompt_basic():
    prompt = build_system_prompt()
    assert "You are MindPal" in prompt
    assert "NOT a therapist" in prompt
    assert "USER CONTEXT" not in prompt
    assert "GROUNDING KNOWLEDGE" not in prompt

def test_build_system_prompt_with_locale():
    prompt = build_system_prompt(locale="ar")
    assert "Arabic" in prompt

def test_build_system_prompt_with_memory():
    prompt = build_system_prompt(memory_summary="User likes walking")
    assert "USER CONTEXT" in prompt
    assert "User likes walking" in prompt

def test_build_system_prompt_with_rag():
    rag = [{"category": "Breathing", "instructions": "Breathe in 4s"}]
    prompt = build_system_prompt(rag_grounding=rag)
    assert "GROUNDING KNOWLEDGE" in prompt
    assert "Breathing" in prompt
    assert "Breathe in 4s" in prompt
