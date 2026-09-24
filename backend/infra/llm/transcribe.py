"""Speech to text for composer dictation, in any language and mixed languages.

Browser speech recognition needs one fixed language up front (it was hard-coded
to en-US, so Arabic came back as English gibberish) and cannot follow someone
who switches language mid-sentence. Whisper detects the language itself and
copes with code-switching, so dictation records audio and sends it here.

Primary: Groq Whisper (OpenAI-compatible /audio/transcriptions). Fallback:
Gemini, which transcribes audio as an ordinary multimodal prompt.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
import httpx

from backend.configs.llm import groq_api_key, groq_base_url, groq_stt_model
from backend.configs.settings import get_settings

logger = logging.getLogger("mindpal.transcribe")

TIMEOUT_SECONDS = 30.0
# Whisper imitates its prompt's language, so no single prompt fits everyone
# (measured on real English, Arabic and mixed voice notes, tests/fixtures/speech):
#   no prompt         English right, Arabic right, mixed transliterated ("مي مانجر")
#   English prompt    Arabic *translated* into English
#   bilingual prompt  Arabic right, mixed right, English turned into Arabic
# So the first pass has no prompt and detects the language; when that is a
# language people often mix with English, a second pass with a prompt written
# in that mix keeps each word in the script it was spoken in.
_MIXED_PROMPTS = {
    "arabic": "مرحبا، اليوم كان يوم طويل. Honestly, I just need to talk. وحاسس اني تعبان.",
}
_GEMINI_INSTRUCTION = (
    "Transcribe this voice note exactly as spoken. Keep every word in the language and script it was spoken in, "
    "including mixed languages in one sentence. Output only the transcript, no notes. If there is no speech, output nothing."
)


class TranscriptionUnavailable(RuntimeError):
    """No provider could transcribe (not configured, rate-limited, or failed)."""


@dataclass(frozen=True)
class Transcript:
    text: str
    language: str  # ISO-639-1 or Whisper's language name; "" when unknown
    provider: str


def transcription_available() -> bool:
    return bool(groq_api_key() or get_settings().resolved_gemini_api_key())


def _filename_for(content_type: str) -> str:
    base = content_type.split(";", 1)[0].strip().lower()
    return {
        "audio/webm": "speech.webm",
        "audio/ogg": "speech.ogg",
        "audio/mp4": "speech.m4a",
        "audio/aac": "speech.aac",
        "audio/mpeg": "speech.mp3",
        "audio/wav": "speech.wav",
        "audio/x-wav": "speech.wav",
    }.get(base, "speech.webm")


def _groq_pass(audio: bytes, content_type: str, prompt: str) -> Transcript:
    data = {"model": groq_stt_model(), "response_format": "verbose_json", "temperature": "0"}
    if prompt:
        data["prompt"] = prompt
    response = httpx.post(
        f"{groq_base_url().rstrip('/')}/audio/transcriptions",
        headers={"Authorization": f"Bearer {groq_api_key()}"},
        data=data,
        files={"file": (_filename_for(content_type), audio, content_type.split(";", 1)[0] or "audio/webm")},
        timeout=TIMEOUT_SECONDS,
    )
    if response.status_code >= 400:
        raise TranscriptionUnavailable(f"groq {response.status_code}: {response.text[:200]}")
    body = response.json()
    return Transcript(text=str(body.get("text") or "").strip(), language=str(body.get("language") or "").lower(), provider="groq")


def _via_groq(audio: bytes, content_type: str) -> Transcript:
    first = _groq_pass(audio, content_type, "")
    mixed_prompt = _MIXED_PROMPTS.get(first.language)
    if not mixed_prompt or not first.text:
        return first
    try:
        second = _groq_pass(audio, content_type, mixed_prompt)
    except TranscriptionUnavailable:
        return first
    return second if second.text else first


def _via_gemini(audio: bytes, content_type: str) -> Transcript:
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=get_settings().resolved_gemini_api_key())
    result = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=[
            types.Part.from_bytes(data=audio, mime_type=content_type.split(";", 1)[0] or "audio/webm"),
            _GEMINI_INSTRUCTION,
        ],
        config=types.GenerateContentConfig(
            temperature=0.0,
            thinking_config=types.ThinkingConfig(thinking_budget=0),
            http_options=types.HttpOptions(timeout=int(TIMEOUT_SECONDS * 1000)),
        ),
    )
    return Transcript(text=(result.text or "").strip(), language="", provider="gemini")


def transcribe_audio(audio: bytes, content_type: str) -> Transcript:
    """Transcribe a short voice note. Raises TranscriptionUnavailable when nothing could."""
    errors = []
    if groq_api_key():
        try:
            return _via_groq(audio, content_type)
        except Exception as exc:  # fall through to the next provider
            errors.append(f"groq: {type(exc).__name__}")
            logger.warning("transcribe_provider_failed provider=groq detail=%s", str(exc)[:200])
    if get_settings().resolved_gemini_api_key():
        try:
            return _via_gemini(audio, content_type)
        except Exception as exc:
            errors.append(f"gemini: {type(exc).__name__}")
            logger.warning("transcribe_provider_failed provider=gemini detail=%s", str(exc)[:200])
    raise TranscriptionUnavailable(", ".join(errors) or "no transcription provider configured")
