"""Generate the short voice samples behind "Preview" in Settings > Voice.

    python scripts/ops/voice_previews.py            # missing clips only
    python scripts/ops/voice_previews.py --force    # regenerate all

Each voice says one English and one Arabic line, the way a friend picking up
the phone would, rendered with Gemini TTS (the same voice catalogue the live
model uses) and encoded to small mono MP3s with ffmpeg:
frontend/assets/voice-previews/<Voice>-<en|ar>.mp3. Needs GEMINI_API_KEY.

    --engine live   render with the live call model instead (the exact voice a
                    caller hears; also works when the TTS daily quota is spent).
                    The spoken words are checked against the line.
"""

from __future__ import annotations

import argparse
import asyncio
import re
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
OUT = ROOT / "frontend" / "assets" / "voice-previews"

LINES = {
    "en": "Hey, it's really good to hear you. So... how's your day actually going?",
    "ar": "هلا والله! حلو إني أسمع صوتك. قول لي، كيف يومك بصراحة؟",
}


def voices() -> list[str]:
    from backend.configs.runtime import voice_runtime_config

    return list(voice_runtime_config()["token"]["allowed_voice_ids"])


def render(client, voice: str, text: str) -> bytes:
    from google.genai import types

    result = client.models.generate_content(
        model="gemini-2.5-flash-preview-tts",
        contents=f"Say it warmly and naturally, like a friend picking up the phone: {text}",
        config=types.GenerateContentConfig(
            response_modalities=["AUDIO"],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice))
            ),
        ),
    )
    return result.candidates[0].content.parts[0].inline_data.data  # 24 kHz 16-bit mono PCM


async def _render_live(client, model: str, voice: str, text: str) -> tuple[bytes, str]:
    from google.genai import types

    config = types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        system_instruction=(
            "You are a voice actor recording a short sample. Read the user's line exactly as written, warmly and "
            "naturally, like a friend picking up the phone. Say nothing else."
        ),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice))
        ),
    )
    pcm, said = bytearray(), ""
    async with client.aio.live.connect(model=model, config=config) as session:
        await session.send_client_content(turns=types.Content(role="user", parts=[types.Part(text=text)]), turn_complete=True)
        async for message in session.receive():
            content = getattr(message, "server_content", None)
            if content is None:
                continue
            for part in getattr(getattr(content, "model_turn", None), "parts", None) or []:
                if part.inline_data and part.inline_data.data:
                    pcm += part.inline_data.data
            transcription = getattr(content, "output_transcription", None)
            if transcription and transcription.text:
                said += transcription.text
            if getattr(content, "turn_complete", False):
                break
    return bytes(pcm), said.strip()


def _words(text: str) -> set[str]:
    return {w for w in re.findall(r"\w+", text.lower()) if len(w) > 2}


def render_live(client, model: str, voice: str, text: str) -> bytes:
    pcm, said = asyncio.run(_render_live(client, model, voice, text))
    expected = _words(text)
    if not pcm or len(expected & _words(said)) < 0.6 * len(expected):
        raise ValueError(f"said something else: {said[:80]!r}")
    return pcm


def encode(pcm: bytes, target: Path) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "clip.wav"
        with wave.open(str(wav), "wb") as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(24000)
            out.writeframes(pcm)
        subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-y", "-i", str(wav), "-ac", "1", "-ar", "24000", "-b:a", "48k", str(target)],
            check=True,
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--engine", choices=("tts", "live"), default="tts")
    args = parser.parse_args()

    from google import genai

    from backend.configs.settings import get_settings

    client = genai.Client(api_key=get_settings().resolved_gemini_api_key())
    if args.engine == "live":
        from backend.domain.voice.services.token import live_model_id

        live_client = genai.Client(api_key=get_settings().resolved_gemini_api_key(), http_options={"api_version": "v1alpha"})
        model = live_model_id()
        speak = lambda voice, text: render_live(live_client, model, voice, text)  # noqa: E731
    else:
        speak = lambda voice, text: render(client, voice, text)  # noqa: E731
    OUT.mkdir(parents=True, exist_ok=True)
    for voice in voices():
        for lang, text in LINES.items():
            target = OUT / f"{voice}-{lang}.mp3"
            if target.exists() and not args.force:
                continue
            for attempt in range(3):
                try:
                    encode(speak(voice, text), target)
                    print(f"  {target.name} ({target.stat().st_size // 1024} KB)")
                    break
                except Exception as exc:  # rate limits or a wrong take: wait and retry
                    print(f"  {voice}-{lang}: {type(exc).__name__}: {str(exc)[:100]}, retrying", file=sys.stderr)
                    time.sleep(20 * (attempt + 1))
            time.sleep(2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
