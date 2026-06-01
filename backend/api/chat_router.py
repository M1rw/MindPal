import logging
from fastapi import APIRouter, BackgroundTasks

from models.schemas import ChatRequest, ChatResponse
from core.prompts import ChatMode
from services.llm_service import generate_therapeutic_response
from services.safety_service import analyze_message_safety
from services.db_service import get_user_long_term_summary, backup_chat_turn, log_crisis_event

# Initialize specific logger for API traffic
logger = logging.getLogger("mindpal_api")
logger.setLevel(logging.INFO)

# Initialize the router
router = APIRouter()

# Constants for Memory Management
MAX_CONTEXT_TURNS = 10  # Sliding window: keep only the last 10 messages for speed & cost

@router.post("/chat", response_model=ChatResponse, summary="Process user message and generate therapeutic response")
async def chat_endpoint(request: ChatRequest, background_tasks: BackgroundTasks):
    """
    Core interaction endpoint for MindPal. 
    Handles sliding-window context compaction, initiates the multi-provider LLM chain,
    and returns a guaranteed structured response.
    """
    logger.info(f"Received chat request from user_id: {request.user_id} | Mode: {request.mode}")
    
    try:
        # --- 0. SAFETY CHECK (Crisis Funnel) ---
        is_safe, flag_reason, crisis_text = await analyze_message_safety(request.message)

        if not is_safe:
            logger.warning(f"User {request.user_id} triggered crisis funnel. Reason: {flag_reason}")
            # Log this severe event to the database for admin review
            background_tasks.add_task(log_crisis_event, request.user_id, request.message, flag_reason)

            return ChatResponse(
                status="crisis_intercept",
                response_text=crisis_text,
                provider_used="safety_funnel",
                lock_session=False
            )

        # --- 1. CONTEXT COMPACTION (Sliding Window) ---
        # Prevent token explosion by only sending the most recent N messages to the LLM.
        # The frontend/database retains the full history for the user's view.
        sliced_history = request.history[-MAX_CONTEXT_TURNS:] if request.history else []
        
        # --- 2. LONG-TERM MEMORY ---
        # Fetch the user's compressed psychological summary from Firebase
        long_term_summary = await get_user_long_term_summary(request.user_id)
        
        # --- 3. GENERATE AI RESPONSE ---
        # Await the orchestrator which handles prompts, routing, and fallbacks.
        # Currently mapping user_id to user_name as a placeholder until the user profile DB is wired.
        response_text, provider = await generate_therapeutic_response(
            message=request.message,
            mode=ChatMode(request.mode),
            history=sliced_history,
            user_name="Friend", # Fallback name; will map to DB later
            long_term_summary=long_term_summary
        )
        
        # --- 4. ASYNC BACKGROUND TASKS ---
        # Silently backup this exact conversation turn to the user's secure DB history
        background_tasks.add_task(
            backup_chat_turn,
            request.user_id,
            request.message,
            response_text,
            request.mode,
        )
        
        return ChatResponse(
            status="success",
            response_text=response_text,
            provider_used=provider,
            lock_session=False
        )

    except Exception as e:
        # Catch-all for extreme API failures, ensuring we never return an unhandled 500 error
        # that could crash the frontend UI or leak stack traces to the client.
        logger.error(f"Critical error processing chat for {request.user_id}: {str(e)}", exc_info=True)
        
        # Construct a safe, deterministic fallback based on the requested mode to prevent UI parser breaks
        fallback_text = (
            "I'm having a little trouble connecting to my network right now. "
            "Take a deep, slow breath, and let's try again in a moment."
        )
        
        if request.mode == ChatMode.COGNITIVE_TOOLS.value:
            fallback_text = (
                "**Thought:** The connection is overwhelmed right now.\n"
                "**Distortion:** Magnification (assuming everything is broken).\n"
                "**Evidence For:** The system threw an error.\n"
                "**Evidence Against:** It's a temporary tech glitch, not a permanent failure.\n"
                "**Balanced Reframe:** Tech hiccups happen, but I can use this exact moment to pause and reset.\n"
                "**Next Tiny Action:** Drop your shoulders, stretch your neck, and try sending your message again."
            )
            
        return ChatResponse(
            status="error",
            response_text=fallback_text,
            provider_used="error_fallback",
            lock_session=False
        )