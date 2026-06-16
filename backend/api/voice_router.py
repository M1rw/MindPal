# backend/api/voice_router.py

from __future__ import annotations

import httpx
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel
import json
import asyncio

from backend.core.config import get_settings

router = APIRouter(prefix="/api/voice", tags=["voice"])


class TranscribeRequest(BaseModel):
    audio_base64: str
    mime_type: str = "audio/webm"


class TranscribeResponse(BaseModel):
    text: str


@router.post("/transcribe", response_model=TranscribeResponse)
async def transcribe_audio(payload: TranscribeRequest) -> TranscribeResponse:
    """
    Transcribes audio using Gemini 1.5 Flash's multimodal audio API.
    This works for 100+ languages natively and handles heavy accents flawlessly.
    """
    settings = get_settings()
    api_key = getattr(settings, "GEMINI_API_KEY", None)
    
    if hasattr(api_key, "get_secret_value"):
        api_key = api_key.get_secret_value()

    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Gemini API key is not configured for audio transcription.",
        )

    # Fetch available models to ensure we pick one that exists
    models_url = f"https://generativelanguage.googleapis.com/v1beta/models?key={api_key}"
    
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            models_response = await client.get(models_url)
            models_response.raise_for_status()
            available_models = models_response.json().get("models", [])
            valid_models = [m["name"] for m in available_models if "generateContent" in m.get("supportedGenerationMethods", [])]
        except Exception:
            valid_models = ["models/gemini-1.5-flash"]
            
    # Prefer 1.5 flash, then 1.5 pro, then anything available
    target_models = ["models/gemini-1.5-flash", "models/gemini-1.5-pro", "models/gemini-1.5-flash-latest"]
    model_path = next((m for m in target_models if m in valid_models), valid_models[0] if valid_models else "models/gemini-1.5-flash")

    url = f"https://generativelanguage.googleapis.com/v1beta/{model_path}:generateContent?key={api_key}"

    prompt = (
        "Transcribe this audio precisely in the exact original language(s) spoken. "
        "CRITICAL: DO NOT translate the audio to English. If the user speaks in Arabic, transcribe in Arabic. "
        "If multiple languages are spoken, transcribe each part in its respective language. "
        "Do not answer the audio. Do not add any text other than the transcription itself."
    )

    clean_mime_type = payload.mime_type.split(";")[0] if payload.mime_type else "audio/webm"

    gemini_payload = {
        "contents": [
            {
                "parts": [
                    {
                        "inlineData": {
                            "mimeType": clean_mime_type,
                            "data": payload.audio_base64
                        }
                    },
                    {
                        "text": prompt
                    }
                ]
            }
        ],
        "generationConfig": {
            "temperature": 0.0,
        }
    }

    async with httpx.AsyncClient(timeout=45.0) as client:
        try:
            response = await client.post(
                url,
                headers={"Content-Type": "application/json"},
                json=gemini_payload
            )
            response.raise_for_status()
            data = response.json()
            
            candidates = data.get("candidates")
            if not candidates:
                return TranscribeResponse(text="")
                
            parts = candidates[0].get("content", {}).get("parts", [])
            text = "".join(part.get("text", "") for part in parts)
            
            return TranscribeResponse(text=text.strip())
            
        except httpx.HTTPStatusError as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Gemini transcription failed: {exc.response.text}"
            )
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Error transcribing audio: {str(exc)}"
            )

@router.get("/key")
async def get_voice_key():
    settings = get_settings()
    api_key = getattr(settings, "GEMINI_API_KEY", None)
    
    if hasattr(api_key, "get_secret_value"):
        api_key = api_key.get_secret_value()

    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Gemini API key is not configured."
        )
        
    return {"key": api_key}


class SummarizeRequest(BaseModel):
    user_transcript: str = ""
    ai_transcript: str = ""


@router.post("/summarize")
async def summarize_call(payload: SummarizeRequest):
    settings = get_settings()
    api_key = getattr(settings, "GEMINI_API_KEY", None)
    if hasattr(api_key, "get_secret_value"):
        api_key = api_key.get_secret_value()

    if not api_key:
        raise HTTPException(status_code=503, detail="No API key")

    transcript_parts = []
    if payload.user_transcript:
        transcript_parts.append(f"User: {payload.user_transcript[:2000]}")
    if payload.ai_transcript:
        transcript_parts.append(f"AI: {payload.ai_transcript[:2000]}")
    transcript = "\n".join(transcript_parts)

    if not transcript.strip():
        return {"summary": "Voice call"}

    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={api_key}"

    gemini_payload = {
        "contents": [{"parts": [{"text": f"Write a 1-sentence summary of this voice call. Keep it under 15 words. Be natural and concise. Respond in the same language used in the conversation:\n\n{transcript}"}]}],
        "generationConfig": {"maxOutputTokens": 60, "temperature": 0.2}
    }

    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            response = await client.post(url, headers={"Content-Type": "application/json"}, json=gemini_payload)
            response.raise_for_status()
            data = response.json()
            candidates = data.get("candidates", [])
            if candidates:
                parts = candidates[0].get("content", {}).get("parts", [])
                summary = "".join(p.get("text", "") for p in parts).strip()
                if summary:
                    return {"summary": summary}
            return {"summary": "Voice call"}
        except Exception as exc:
            print(f"[VOICE_SUMMARIZE] Error: {exc}")
            return {"summary": "Voice call"}
