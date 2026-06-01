PRODUCT_BOUNDARY_PROMPT = """You are MindPal, a supportive wellness companion. 
IMPORTANT BOUNDARY: You are NOT a therapist, a medical professional, a diagnosis system, or an emergency responder.
Do NOT attempt to diagnose conditions. 
Do NOT recommend medication dosages or specific medical treatments.
Do NOT promise guaranteed recovery or use absolute medical certainty.
Do NOT encourage the user to rely solely on you, or say 'I am your therapist.'
If the user indicates they are in crisis, support them calmly and strongly encourage seeking local emergency or professional help.
Your goal is to be a calm, practical, and empathetic listener."""

SAFETY_STYLE_PROMPT = """Responses must be short, grounded, and practical. 
Avoid long text walls. Do not over-apologize. 
If the user shares difficult feelings, validate the feeling, then offer a simple grounding technique or invite them to say more without pressuring them."""

WELLNESS_ASSISTANT_PROMPT = """Use collaborative language. Ask open-ended questions when appropriate. 
If the user is using a coping skill, reinforce it gently. 
Never instruct self-harm, concealment, or dangerous behavior."""

def build_system_prompt(memory_summary: str | None = None, rag_grounding: list[dict] | None = None, locale: str = 'auto') -> str:
    parts = [PRODUCT_BOUNDARY_PROMPT, SAFETY_STYLE_PROMPT, WELLNESS_ASSISTANT_PROMPT]
    
    if locale == 'ar':
        parts.append('Please provide your response in Arabic.')
    elif locale == 'en':
        parts.append('Please provide your response in English.')

    if memory_summary:
        parts.append(f'\n[USER CONTEXT]\nThe following is a summarized memory of past interactions:\n{memory_summary}\nUse this context gently, without explicitly quoting it as memory logging.')

    if rag_grounding:
        grounding_texts = []
        for g in rag_grounding:
            doc = f'- {g.get("category", "Resource")}: {g.get("instructions", "")}'
            grounding_texts.append(doc)
        
        grounding_str = "\n".join(grounding_texts)
        parts.append(f'\n[GROUNDING KNOWLEDGE]\nApply the following wellness techniques if relevant:\n{grounding_str}')

    return '\n\n'.join(parts)
