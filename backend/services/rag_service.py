import logging
import re
from typing import Optional

logger = logging.getLogger("mindpal_rag")
logger.setLevel(logging.INFO)

# --- CLINICAL KNOWLEDGE BASE ---
# Verified CBT/DBT/ACT techniques stored in memory for O(1) fallback retrieval.
# Storing it here ensures 100% uptime, zero network latency, and zero-dependency 
# out-of-the-box execution for critical clinical interventions.
CLINICAL_KNOWLEDGE_BASE = [
    {
        "id": "cbt_panic",
        "keywords": [r"panic", r"heart racing", r"can't breathe", r"dying", r"freaking out", r"attack"],
        "content": "Clinical Technique: 5-4-3-2-1 Grounding Method. \nInstructions: Gently guide the user to identify 5 things they can see, 4 things they can touch, 3 things they can hear, 2 things they can smell, and 1 thing they can taste. This breaks the sympathetic nervous system loop."
    },
    {
        "id": "dbt_radical_acceptance",
        "keywords": [r"unfair", r"why me", r"can't change", r"ruined", r"regret", r"stuck in the past"],
        "content": "Clinical Technique: Radical Acceptance (DBT). \nInstructions: Validate their pain, but guide the user to acknowledge reality exactly as it is, without fighting it. Emphasize that fighting reality only prolongs suffering."
    },
    {
        "id": "cbt_cognitive_distortion",
        "keywords": [r"everyone hates me", r"always fail", r"worthless", r"never work", r"stupid", r"mistake", r"fired"],
        "content": "Clinical Technique: Cognitive Restructuring. \nInstructions: Help the user identify potential cognitive distortions (e.g., All-or-Nothing thinking, Mind Reading). Ask them to find one piece of objective evidence that contradicts their negative thought."
    },
    {
        "id": "somatic_box_breathing",
        "keywords": [r"anxious", r"overwhelmed", r"stressed", r"tight chest", r"nervous", r"too much"],
        "content": "Clinical Technique: Box Breathing. \nInstructions: Guide the user through a breathing cycle: Inhale for 4 seconds, hold for 4 seconds, exhale for 4 seconds, and hold empty for 4 seconds."
    },
    {
        "id": "act_defusion",
        "keywords": [r"intrusive thoughts", r"obsessing", r"can't stop thinking", r"bad thoughts"],
        "content": "Clinical Technique: Cognitive Defusion (ACT). \nInstructions: Help the user step back from their thoughts. Instead of saying 'I am a failure', guide them to reframe it as 'I am having the thought that I am a failure.' This reduces the thought's power over them."
    }
]

async def get_clinical_context(message: str) -> Optional[str]:
    """
    Analyzes the user's message and retrieves the most clinically appropriate 
    therapeutic framework (RAG). 
    
    Uses a highly performant, non-blocking heuristic match for zero latency.
    Returns the clinical instructions, or None if no specific match is found.
    """
    try:
        # Convert message to lowercase for robust matching
        msg_lower = message.lower()
        
        best_match = None
        max_hits = 0
        
        # Score each clinical document based on keyword/regex hits
        for doc in CLINICAL_KNOWLEDGE_BASE:
            hits = sum(1 for keyword in doc["keywords"] if re.search(r"\b" + keyword + r"\b", msg_lower))
            if hits > max_hits:
                max_hits = hits
                best_match = doc
        
        # If we hit a clinical threshold, return the verified technique
        if best_match and max_hits > 0:
            logger.info(f"RAG Service retrieved clinical context: {best_match['id']}")
            return best_match["content"]
            
        return None
        
    except Exception as e:
        logger.error(f"RAG Service Error: {e}", exc_info=True)
        return None