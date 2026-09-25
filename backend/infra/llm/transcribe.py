"""Speech to text for composer dictation, in any language and mixed languages.

Browser speech recognition needs one fixed language up front (it was hard-coded
to en-US, so Arabic came back as English gibberish) and cannot follow someone
who switches language mid-sentence. Whisper detects the language itself and
copes with code-switching, so dictation records audio and sends it here.

Whisper picks ONE language from the start of the note, and when the speaker
switches it drops the rest (measured on real clips, tests/fixtures/speech: an
English sentence then an Arabic one came back as the Arabic only, the reverse
as the English only). Gemini Flash-Lite transcribes both orders and
mid-sentence mixing correctly in 2-3 s. So:

  - someone who speaks more than English (the browser's languages, their voice
    setting, or Arabic they dictated before; sent as hints) goes to Gemini;
  - otherwise Whisper runs first (fastest); English is kept as is, and any
    other language it hears is re-done by Gemini, which keeps mixed speech;
  - Whisper (with the mixed-language prompt) is the fallback when Gemini fails.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Sequence

import httpx

from backend.configs.llm import groq_api_key, groq_base_url, groq_stt_model
from backend.configs.settings import get_settings
from backend.infra.llm.thinking import thinking_kwargs

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
DEFAULT_GEMINI_STT_MODELS = ("gemini-3.5-flash-lite", "gemini-3.8-flash")
_GEMINI_INSTRUCTION = (
    "Transcribe this voice note exactly as spoken, from the first word to the last. The speaker may switch "
    "language partway through (for example Arabic then English, or English then Arabic, or both within one "
    "sentence): transcribe every part in the language and script it was spoken in, in the order spoken. "
    "Never translate, summarise or skip a part because it is in another language. Output only the transcript, "
    "no notes. If there is no speech, output nothing."
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
    return _with_mixed_pass(_groq_pass(audio, content_type, ""), audio, content_type)


def _with_mixed_pass(first: Transcript, audio: bytes, content_type: str) -> Transcript:
    """A second Whisper pass, prompted in the mix, for languages often mixed with English."""
    mixed_prompt = _MIXED_PROMPTS.get(first.language)
    if not mixed_prompt or not first.text:
        return first
    try:
        second = _groq_pass(audio, content_type, mixed_prompt)
    except TranscriptionUnavailable:
        return first
    return second if second.text else first


def _gemini_models() -> list[str]:
    configured = [m.strip() for m in (get_settings().dictation_gemini_models or "").split(",") if m.strip()]
    return configured or list(DEFAULT_GEMINI_STT_MODELS)


def _script_language(text: str) -> str:
    """Arabic when any Arabic letters were written, English for Latin only, else unknown."""
    arabic = sum(1 for ch in text if 0x0600 <= ord(ch) <= 0x06FF or 0x0750 <= ord(ch) <= 0x077F)
    latin = sum(1 for ch in text if ch.isascii() and ch.isalpha())
    if arabic:
        return "arabic"
    return "english" if latin else ""


def _via_gemini(audio: bytes, content_type: str) -> Transcript:
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=get_settings().resolved_gemini_api_key())
    errors = []
    for model in _gemini_models():
        try:
            result = client.models.generate_content(
                model=model,
                contents=[
                    types.Part.from_bytes(data=audio, mime_type=content_type.split(";", 1)[0] or "audio/webm"),
                    _GEMINI_INSTRUCTION,
                ],
                config=types.GenerateContentConfig(
                    temperature=0.0,
                    http_options=types.HttpOptions(timeout=int(TIMEOUT_SECONDS * 1000)),
                    **thinking_kwargs(model, 0),
                ),
            )
        except Exception as exc:
            errors.append(f"{model}: {type(exc).__name__}")
            logger.warning("transcribe_gemini_model_failed model=%s detail=%s", model, str(exc)[:200])
            continue
        text = (result.text or "").strip()
        return Transcript(text=text, language=_script_language(text), provider="gemini")
    raise TranscriptionUnavailable("gemini: " + ", ".join(errors))


def speaks_beyond_english(languages: Sequence[str]) -> bool:
    """True when the hints name any language besides English ("ar", "arabic", "fr-FR", ...)."""
    return any(lang and not lang.lower().startswith("en") for lang in languages)


def transcribe_audio(audio: bytes, content_type: str, languages: Sequence[str] = ()) -> Transcript:
    """Transcribe a short voice note. Raises TranscriptionUnavailable when nothing could.

    `languages` are hints about who is speaking (browser languages, voice
    setting, languages they dictated before); never trusted beyond routing.
    """
    has_groq = bool(groq_api_key())
    has_gemini = bool(get_settings().resolved_gemini_api_key())
    errors: list[str] = []
    first: Transcript | None = None

    if has_groq and not (has_gemini and speaks_beyond_english(languages)):
        try:
            first = _groq_pass(audio, content_type, "")
        except Exception as exc:
            errors.append(f"groq: {type(exc).__name__}")
            logger.warning("transcribe_provider_failed provider=groq detail=%s", str(exc)[:200])
        else:
            if not first.text or first.language in ("english", "en") or not has_gemini:
                return _with_mixed_pass(first, audio, content_type)

    if has_gemini:
        try:
            return _via_gemini(audio, content_type)
        except Exception as exc:
            errors.append(f"gemini: {type(exc).__name__}")
            logger.warning("transcribe_provider_failed provider=gemini detail=%s", str(exc)[:200])

    if first is not None:
        return _with_mixed_pass(first, audio, content_type)
    if has_groq and not any(e.startswith("groq") for e in errors):
        try:
            return _via_groq(audio, content_type)
        except Exception as exc:
            errors.append(f"groq: {type(exc).__name__}")
            logger.warning("transcribe_provider_failed provider=groq detail=%s", str(exc)[:200])
    raise TranscriptionUnavailable(", ".join(errors) or "no transcription provider configured")
