from typing import List, Literal
from pydantic import BaseModel, Field, ConfigDict

class MessageTurn(BaseModel):
    # Strictly limit roles to exactly what our frontend sends
    role: Literal["User", "MindPal"] = Field(..., description="The sender of the message")
    text: str = Field(..., min_length=1, description="The content of the message")

class ChatRequest(BaseModel):
    user_id: str = Field(..., description="Unique identifier for the user (from Firebase)")
    message: str = Field(..., min_length=1, max_length=2000, description="The user's current message")
    
    # Strictly limit the modes to our engineered prompts
    mode: Literal["Active Listen", "Guided Coach", "Cognitive Tools"] = Field(
        default="Active Listen", 
        description="The current therapeutic mode"
    )
    
    # History is a list of MessageTurns, defaults to empty list
    history: List[MessageTurn] = Field(default_factory=list, description="Sliding window of recent history")

    model_config = ConfigDict(extra="ignore")

class ChatResponse(BaseModel):
    # Status helps the frontend know if it needs to trigger the locked Crisis UI
    status: Literal["success", "crisis_intercept", "error"]
    response_text: str
    provider_used: str = Field(default="gemini", description="Which LLM answered this (Gemini, Groq, etc.)")
    lock_session: bool = Field(default=False, description="Set to True if the crisis funnel was triggered")

    model_config = ConfigDict(extra="ignore")