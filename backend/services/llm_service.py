import httpx
import logging
from typing import List, Dict, Any, Tuple
from fastapi import HTTPException

from core.config import settings
from core.prompts import build_system_prompt, ChatMode
from models.schemas import MessageTurn, ChatResponse

# Configure logging to track which providers are succeeding/failing
logger = logging.getLogger("mindpal_llm")
logger.setLevel(logging.INFO)

# --- HELPER FUNCTIONS ---

def _format_gemini_history(history: List[MessageTurn], current_message: str) -> List[Dict[str, Any]]:
    """Formats our standard history into Google Gemini's specific JSON structure."""
    formatted = []
    for turn in history:
        # Gemini expects roles to be exactly 'user' or 'model'
        role = "user" if turn.role == "User" else "model"
        formatted.append({"role": role, "parts": [{"text": turn.text}]})
    
    # Append the current message
    formatted.append({"role": "user", "parts": [{"text": current_message}]})
    return formatted

def _format_openai_history(system_prompt: str, history: List[MessageTurn], current_message: str) -> List[Dict[str, str]]:
    """Formats history for OpenAI-compatible APIs (OpenRouter, Groq)."""
    messages = [{"role": "system", "content": system_prompt}]
    for turn in history:
        role = "user" if turn.role == "User" else "assistant"
        messages.append({"role": role, "content": turn.text})
    
    messages.append({"role": "user", "content": current_message})
    return messages

# --- PROVIDER CALLS ---

async def _call_gemini(client: httpx.AsyncClient, system_prompt: str, contents: List[Dict[str, Any]]) -> str:
    """Primary Provider: Google Gemini (Fast, excellent reasoning, native prompt caching)."""
    if not settings.GEMINI_API_KEY:
        raise ValueError("GEMINI_API_KEY is not configured.")

    # Using the latest 2.5 flash preview model for speed and capability
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key={settings.GEMINI_API_KEY}"
    
    payload = {
        "contents": contents,
        "systemInstruction": {"parts": [{"text": system_prompt}]}
    }

    # 15 second timeout to ensure we fail over quickly if Google is down
    response = await client.post(url, json=payload, timeout=15.0)
    response.raise_for_status()
    
    data = response.json()
    try:
        return data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError):
        raise ValueError("Unexpected response structure from Gemini.")

async def _call_openrouter(client: httpx.AsyncClient, messages: List[Dict[str, str]]) -> str:
    """Secondary Provider: OpenRouter (Aggregator for Claude 3 Haiku / Llama 3)."""
    if not settings.OPENROUTER_API_KEY:
        raise ValueError("OPENROUTER_API_KEY is not configured.")

    url = "https://openrouter.ai/api/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {settings.OPENROUTER_API_KEY}",
        "HTTP-Referer": "https://mindpal.com", # Required by OpenRouter
        "X-Title": settings.PROJECT_NAME,
    }
    payload = {
        "model": "anthropic/claude-3-haiku", # Extremely fast, highly empathetic fallback
        "messages": messages,
        "temperature": 0.7
    }

    response = await client.post(url, headers=headers, json=payload, timeout=12.0)
    response.raise_for_status()
    
    return response.json()["choices"][0]["message"]["content"]

async def _call_groq(client: httpx.AsyncClient, messages: List[Dict[str, str]]) -> str:
    """Tertiary Provider: Groq (Ultra-low latency LPU inference for emergency speed)."""
    if not settings.GROQ_API_KEY:
        raise ValueError("GROQ_API_KEY is not configured.")

    url = "https://api.groq.com/openai/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {settings.GROQ_API_KEY}",
    }
    payload = {
        "model": "llama3-8b-8192", # Blazing fast open-weight model
        "messages": messages,
        "temperature": 0.7
    }

    response = await client.post(url, headers=headers, json=payload, timeout=8.0)
    response.raise_for_status()
    
    return response.json()["choices"][0]["message"]["content"]

# --- MAIN ORCHESTRATOR ---

async def generate_therapeutic_response(
    message: str, 
    mode: ChatMode, 
    history: List[MessageTurn], 
    user_name: str = "Friend", 
    long_term_summary: str = None,
    clinical_context: str = None
) -> Tuple[str, str]:
    """
    Orchestrates the LLM fallback chain. 
    Returns a tuple of (response_text, provider_used).
    """
    
    # 1. Construct the mathematically strict system prompt
    system_prompt = build_system_prompt(mode=mode, user_name=user_name, long_term_summary=long_term_summary)

    # Inject RAG Clinical Context if retrieved
    if clinical_context:
        system_prompt += (
            "\n\n[CLINICAL GROUNDING]\n"
            "Use the following verified technique to guide your response safely:\n"
            f"{clinical_context}\n"
            "[/CLINICAL GROUNDING]"
        )
    
    # 2. Utilize a single AsyncClient context for connection pooling and high performance
    async with httpx.AsyncClient() as client:
        
        # --- ATTEMPT 1: GEMINI ---
        try:
            gemini_contents = _format_gemini_history(history, message)
            response_text = await _call_gemini(client, system_prompt, gemini_contents)
            logger.info("Successfully generated response using Gemini.")
            return response_text, "gemini"
        except Exception as e:
            logger.warning(f"Gemini failed: {str(e)}. Falling back to OpenRouter...")

        # --- ATTEMPT 2: OPENROUTER ---
        try:
            openai_messages = _format_openai_history(system_prompt, history, message)
            response_text = await _call_openrouter(client, openai_messages)
            logger.info("Successfully generated response using OpenRouter.")
            return response_text, "openrouter"
        except Exception as e:
            logger.warning(f"OpenRouter failed: {str(e)}. Falling back to Groq...")

        # --- ATTEMPT 3: GROQ ---
        try:
            # We reuse the openai_messages structure since Groq uses the exact same API format
            response_text = await _call_groq(client, openai_messages)
            logger.info("Successfully generated response using Groq.")
            return response_text, "groq"
        except Exception as e:
            logger.error(f"Groq failed: {str(e)}. All LLM providers exhausted.")

    # --- ATTEMPT 4: DETERMINISTIC OFFLINE FALLBACK ---
    # If every API is down, or if the user didn't configure ANY api keys, 
    # we NEVER leave the user hanging. We provide a safe, hardcoded response.
    logger.critical("Triggering Terminal Offline Fallback.")
    
    fallback_text = (
        "I'm experiencing a bit of a network delay on my end right now, but I am still here with you. "
        "Take a slow, deep breath. We will pick up right where we left off in a moment."
    )
    
    # If they are doing CBT, we must preserve the JSON/Markdown structure to not break the UI
    if mode == ChatMode.COGNITIVE_TOOLS:
        fallback_text = (
            "**Thought:** I am feeling overwhelmed and disconnected.\n"
            "**Distortion:** Mental Filtering.\n"
            "**Evidence For:** The connection dropped.\n"
            "**Evidence Against:** The system is just rebooting, I am not alone.\n"
            "**Balanced Reframe:** Technology glitches sometimes, but I can use this moment to pause.\n"
            "**Next Tiny Action:** Drop your shoulders, take one deep breath, and try sending your message again in a few seconds."
        )

    return fallback_text, "offline_fallback"