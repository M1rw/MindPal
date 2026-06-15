# backend/api/voice_router.py

from __future__ import annotations

import httpx
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

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

    model = "gemini-1.5-flash"
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"

    prompt = "Transcribe this audio precisely. Do not answer it. Do not add any text other than the transcription itself."

    gemini_payload = {
        "contents": [
            {
                "parts": [
                    {
                        "inlineData": {
                            "mimeType": payload.mime_type,
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
