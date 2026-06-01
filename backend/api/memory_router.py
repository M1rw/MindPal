import logging
from fastapi import APIRouter, BackgroundTasks, HTTPException
from typing import List, Optional
from pydantic import BaseModel

from services.memory_service import compress_chat_history
# In a real app with a DB, we would import db_service here to save the summary.
# from services.db_service import save_user_summary, get_user_summary

logger = logging.getLogger("mindpal_api")
logger.setLevel(logging.INFO)

router = APIRouter()

# --- SCHEMAS ---
# These are specific to the memory router, so we define them here or in schemas.py
from models.schemas import MessageTurn

class SummarizeRequest(BaseModel):
    user_id: str
    unsummarized_logs: List[MessageTurn]
    existing_summary: Optional[str] = None

class SummarizeResponse(BaseModel):
    status: str
    message: str

# --- BACKGROUND TASK LOGIC ---

async def background_summarize_task(request_data: SummarizeRequest):
    """
    The actual function that runs in the background. It calls the LLM, 
    gets the new summary, and saves it to the database.
    """
    logger.info(f"Starting background summarization for user {request_data.user_id} ({len(request_data.unsummarized_logs)} messages)")
    
    new_summary = await compress_chat_history(
        unsummarized_logs=request_data.unsummarized_logs,
        existing_summary=request_data.existing_summary
    )
    
    if new_summary:
        logger.info(f"Summarization complete for {request_data.user_id}. Saving to DB...")
        # TODO: Implement Database Write
        # await db_service.save_user_summary(request_data.user_id, new_summary)
        # We also need to mark those raw messages as "summarized" in the DB 
        # so we don't re-summarize them next time.
    else:
        logger.warning(f"Summarization returned None for {request_data.user_id}. Will retry later.")


# --- ENDPOINTS ---

@router.post("/summarize", response_model=SummarizeResponse, summary="Trigger background compression of chat logs")
async def trigger_summarization(request: SummarizeRequest, background_tasks: BackgroundTasks):
    """
    Triggers an asynchronous background task to compress raw chat logs into a dense psychological summary.
    This endpoint returns immediately (202 Accepted style) so the frontend does not hang.
    """
    if len(request.unsummarized_logs) == 0:
        return SummarizeResponse(status="success", message="No logs to summarize.")
        
    # Add the heavy LLM call to FastAPI's background queue.
    # The endpoint will return 'success' instantly, while the server crunches the data invisibly.
    background_tasks.add_task(background_summarize_task, request)
    
    return SummarizeResponse(
        status="success", 
        message="Summarization task queued successfully."
    )