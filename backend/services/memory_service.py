import logging
import httpx
from typing import List, Optional

from core.config import settings
from models.schemas import MessageTurn
from services.llm_service import _call_gemini

logger = logging.getLogger("mindpal_memory")
logger.setLevel(logging.INFO)

# --- PROMPT CONSTANTS ---

SUMMARIZATION_PROMPT = """
You are an expert clinical psychologist and data synthesizer. 
Your task is to analyze the following raw chat log between a user and MindPal (an AI companion).
You must extract the core psychological context, triggers, coping mechanisms, and major life events into a highly compressed, objective summary.

RULES:
1. Keep the summary under 150 words.
2. Focus on recurring themes (e.g., "workplace anxiety", "insomnia", "imposter syndrome").
3. Note specific triggers or life events mentioned (e.g., "dog died recently", "conflict with boss named Sarah").
4. Note which therapeutic interventions worked (e.g., "responds well to box breathing", "finds cognitive reframing helpful").
5. Do NOT include transient or irrelevant details (e.g., "said hello", "asked about the weather").
6. If the user mentions any severe risk factors (even historically), ensure they are permanently noted.
7. Merge this new information seamlessly with the user's existing summary (if provided below).

[EXISTING SUMMARY]
{existing_summary}
[/EXISTING SUMMARY]

Output ONLY the new, compressed summary paragraph. No conversational filler.
"""

# --- CORE FUNCTIONS ---

async def compress_chat_history(
    unsummarized_logs: List[MessageTurn], 
    existing_summary: Optional[str] = None
) -> Optional[str]:
    """
    Takes an array of raw chat messages and asks the LLM to compress them into a 
    dense psychological summary, merging it with any previous summary.
    
    Returns:
        The new string summary, or None if the summarization fails.
    """
    if not unsummarized_logs:
        return existing_summary
        
    # Formatting the logs into a readable text block for the LLM prompt
    log_text = ""
    for turn in unsummarized_logs:
        log_text += f"{turn.role}: {turn.text}\n"

    # Injecting the existing summary into the system instruction if it exists
    current_summary_text = existing_summary if existing_summary else "No prior history."
    system_instruction = SUMMARIZATION_PROMPT.format(existing_summary=current_summary_text)
    
    # We use Gemini explicitly for summarization because of its massive context window
    # and strong reasoning capabilities. We do not use the fallback chain here because
    # this is a background task; if it fails, we can simply retry later without breaking the UI.
    try:
        async with httpx.AsyncClient() as client:
            # Format payload for Gemini
            contents = [{"role": "user", "parts": [{"text": f"Raw Chat Log to Summarize:\n{log_text}"}]}]
            
            # 20 second timeout. Summarization requires reading a lot of text.
            new_summary = await _call_gemini(client, system_instruction, contents)
            
            logger.info("Successfully compressed chat history into a new psychological summary.")
            return new_summary.strip()
            
    except Exception as e:
        # We log the error but DO NOT crash. If summarization fails in the background, 
        # the user's chat experience is unaffected. The unsummarized logs will just remain
        # in the queue for the next attempt.
        logger.error(f"Background summarization failed: {str(e)}")
        return None