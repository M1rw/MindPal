"""Generate the short voice samples behind "Preview" in Settings > Voice.

    python scripts/ops/voice_previews.py            # missing clips only
    python scripts/ops/voice_previews.py --force    # regenerate all

Each voice says one English and one Arabic line, the way a friend picking up
the phone would, rendered with Gemini TTS (the same voice catalogue the live
model uses) and encoded to small mono MP3s with ffmpeg:
frontend/assets/voice-previews/<Voice>-<en|ar>.mp3. Needs GEMINI_API_KEY.
"""

from __future__ import annotations

import argparse
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
    args = parser.parse_args()

    from google import genai

    from backend.configs.settings import get_settings

    client = genai.Client(api_key=get_settings().resolved_gemini_api_key())
    OUT.mkdir(parents=True, exist_ok=True)
    for voice in voices():
        for lang, text in LINES.items():
            target = OUT / f"{voice}-{lang}.mp3"
            if target.exists() and not args.force:
                continue
            for attempt in range(3):
                try:
                    encode(render(client, voice, text), target)
                    print(f"  {target.name} ({target.stat().st_size // 1024} KB)")
                    break
                except Exception as exc:  # rate limits: wait and retry
                    print(f"  {voice}-{lang}: {type(exc).__name__}, retrying", file=sys.stderr)
                    time.sleep(20 * (attempt + 1))
            time.sleep(2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
