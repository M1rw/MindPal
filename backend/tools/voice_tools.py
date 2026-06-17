# backend/tools/voice_tools.py

"""
Voice processing tools for MindPal.

Migrated from voice_router.py. Contains the business logic for voice
transcription and call summarization. The router becomes a thin HTTP wrapper.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from backend.core.config import get_settings
from backend.core.llm_utils import quick_llm_generate
from backend.core.security import sanitize_text
from backend.tools import BaseTool, ToolContext, ToolResult

logger = logging.getLogger(__name__)

MAX_TRANSCRIPT_CHARS = 4_000
MAX_AUDIO_BASE64_CHARS = 15_000_000

_TRANSCRIPTION_MODELS = [
    "models/gemini-2.0-flash",
    "models/gemini-1.5-flash",
    "models/gemini-1.5-flash-latest",
    "models/gemini-1.5-pro",
]


class VoiceSummarizeTool(BaseTool):
    """Summarize a voice call transcript into a short summary."""

    @property
    def name(self) -> str:
        return "voice_summarize"

    @property
    def description(self) -> str:
        return "Summarize a voice call transcript into a 1-sentence summary."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "OBJECT",
            "properties": {
                "user_transcript": {
                    "type": "STRING",
                    "description": "The user's spoken transcript from the voice call",
                },
                "ai_transcript": {
                    "type": "STRING",
                    "description": "The AI's spoken transcript from the voice call",
                },
            },
        }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        user_transcript = sanitize_text(str(args.get("user_transcript", "")), MAX_TRANSCRIPT_CHARS)
        ai_transcript = sanitize_text(str(args.get("ai_transcript", "")), MAX_TRANSCRIPT_CHARS)

        transcript_parts: list[str] = []
        if user_transcript:
            transcript_parts.append(f"User: {user_transcript}")
        if ai_transcript:
            transcript_parts.append(f"AI: {ai_transcript}")
        transcript = "\n".join(transcript_parts)

        if not transcript.strip():
            return ToolResult(data={"summary": "Voice call"})

        prompt = (
            "Write a 1-sentence summary of this voice call. "
            "Keep it under 15 words. Be natural and concise. "
            "Respond in the same language used in the conversation:\n\n"
            + transcript
        )

        try:
            summary = await quick_llm_generate(prompt, max_tokens=60, temperature=0.2)
            return ToolResult(data={"summary": summary or "Voice call"})
        except Exception:
            logger.debug("Voice summarization failed")
            return ToolResult(data={"summary": "Voice call"})


class VoiceTranscribeTool(BaseTool):
    """Transcribe audio to text using Gemini multimodal API."""

    @property
    def name(self) -> str:
        return "voice_transcribe"

    @property
    def description(self) -> str:
        return "Transcribe audio data to text. Supports multiple languages."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "OBJECT",
            "properties": {
                "audio_base64": {
                    "type": "STRING",
                    "description": "Base64-encoded audio data",
                },
                "mime_type": {
                    "type": "STRING",
                    "description": "Audio MIME type (e.g. audio/webm)",
                },
            },
            "required": ["audio_base64"],
        }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        audio_base64 = str(args.get("audio_base64", ""))
        mime_type = sanitize_text(
            str(args.get("mime_type", "audio/webm")),
            80,
        ).split(";")[0].strip() or "audio/webm"

        if not audio_base64:
            return ToolResult(error="audio_base64 is required")

        if len(audio_base64) > MAX_AUDIO_BASE64_CHARS:
            return ToolResult(error="Audio data too large")

        api_key = _get_gemini_key()
        if not api_key:
            return ToolResult(error="Audio transcription service is not available")

        prompt = (
            "Transcribe this audio precisely in the exact original language(s) spoken. "
            "CRITICAL: DO NOT translate the audio to English. If the user speaks in Arabic, transcribe in Arabic. "
            "If multiple languages are spoken, transcribe each part in its respective language. "
            "Do not answer the audio. Do not add any text other than the transcription itself."
        )

        gemini_payload = {
            "contents": [
                {
                    "parts": [
                        {
                            "inlineData": {
                                "mimeType": mime_type,
                                "data": audio_base64,
                            }
                        },
                        {"text": prompt},
                    ],
                }
            ],
            "generationConfig": {
                "temperature": 0.1,
                "maxOutputTokens": 1024,
            },
        }

        async with httpx.AsyncClient(timeout=45.0) as client:
            for model in _TRANSCRIPTION_MODELS:
                url = f"https://generativelanguage.googleapis.com/v1beta/{model}:generateContent"
                try:
                    response = await client.post(
                        url,
                        headers={
                            "Content-Type": "application/json",
                            "x-goog-api-key": api_key,
                        },
                        json=gemini_payload,
                    )
                    if response.status_code == 404:
                        continue
                    response.raise_for_status()

                    data = response.json()
                    candidates = data.get("candidates")
                    if not candidates:
                        return ToolResult(data={"text": ""})

                    parts = candidates[0].get("content", {}).get("parts", [])
                    text = "".join(part.get("text", "") for part in parts).strip()

                    return ToolResult(data={"text": text})

                except httpx.HTTPStatusError:
                    continue
                except Exception:
                    continue

        return ToolResult(error="Audio transcription failed. Please try again.")


def _get_gemini_key() -> str:
    """Safely extract the Gemini API key from settings."""
    settings = get_settings()
    value = getattr(settings, "GEMINI_API_KEY", None)
    if hasattr(value, "get_secret_value"):
        return value.get_secret_value() or ""
    return str(value or "").strip()
