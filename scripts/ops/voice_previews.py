"""Generate the short voice samples behind "Preview" in Settings > Voice.

    python scripts/ops/voice_previews.py            # missing clips only
    python scripts/ops/voice_previews.py --force    # regenerate all
    python scripts/ops/voice_previews.py --force --only Puck,Zephyr

Each voice says its own English and Arabic line in its own manner (VOICE_LINES:
the preview shows the personality, not just the timbre), rendered with Gemini TTS (the same voice catalogue the live
model uses) and encoded to small mono MP3s with ffmpeg:
frontend/assets/voice-previews/<Voice>-<en|ar>.mp3. Needs GEMINI_API_KEY.

    --engine live   render with the live call model instead (the exact voice a
                    caller hears; also works when the TTS daily quota is spent).
                    The spoken words are checked against the line.
"""

from __future__ import annotations

import argparse
import asyncio
import io
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
DEFAULT_DELIVERY = "warmly and naturally, like a friend picking up the phone"

# Each voice gets its own line and delivery, so a preview shows its personality,
# not just its timbre. Arabic is casual Gulf. Voices not listed use LINES.
VOICE_LINES: dict[str, dict[str, str]] = {
    "Sulafat": {
        "delivery": "warm and grounded, unhurried, with a soft smile",
        "en": "Hey, you. Come sit for a minute... how are you, really?",
        "ar": "هلا فيك، تعال ارتاح شوي... كيف حالك من جد؟",
    },
    "Aoede": {
        "delivery": "thoughtful and curious, like sharing an idea over coffee",
        "en": "Okay, I've been thinking about something all day, and I really want your take on it.",
        "ar": "تدري؟ كنت أفكر بشي طول اليوم، وودي أسمع رأيك فيه.",
    },
    "Charon": {
        "delivery": "deep, calm and slow, reassuring",
        "en": "Take a breath. No rush at all. I'm right here, so start wherever you like.",
        "ar": "خذ نفس، ولا تستعجل. أنا هنا، ابدأ من وين ما تبي.",
    },
    "Kore": {
        "delivery": "clear and direct, friendly but to the point",
        "en": "Alright, straight to it: what's the one thing on your mind right now?",
        "ar": "طيب، بدون لف ودوران: وش أكثر شي شاغل بالك الحين؟",
    },
    "Puck": {
        "delivery": "playful and teasing, with a little laugh",
        "en": "Oh, you're back! Haha, I was starting to think you'd found a cooler voice to talk to.",
        "ar": "أوه، رجعت! ههه، قلت خلاص لقيت لك صوت أحلى مني.",
    },
    "Fenrir": {
        "delivery": "energetic and excited, fast and bright",
        "en": "Okay, I can feel it, something happened today. Tell me everything!",
        "ar": "يلا يلا، أحس صار شي اليوم! قول لي كل شي!",
    },
    "Achird": {
        "delivery": "friendly and relaxed, easy to talk to",
        "en": "Hey! Grab a coffee, get comfy. So what's been going on with you?",
        "ar": "هلا! جيب لك قهوة وارتاح. وش أخبارك؟ وش صاير معك؟",
    },
    "Umbriel": {
        "delivery": "easy-going and laid back, a little lazy smile",
        "en": "No plans, no agenda. Just us, chatting. So, how's the week treating you?",
        "ar": "لا خطط ولا شي، بس سوالف. ها، كيف الأسبوع معك؟",
    },
    "Vindemiatrix": {
        "delivery": "gentle and soft-spoken, tender",
        "en": "Hi. It's okay if today was a lot. We can take it slow, together.",
        "ar": "هلا. عادي لو اليوم كان ثقيل، نمشيها شوي شوي مع بعض.",
    },
    "Sadachbia": {
        "delivery": "lively and bubbly, words tumbling out",
        "en": "Wait, wait, before anything, did you hear what happened? No? Okay, you first!",
        "ar": "لحظة لحظة! سمعت وش صار؟ لا؟ طيب خلاص، إنت أول!",
    },
    "Laomedeia": {
        "delivery": "upbeat and cheerful, sunny",
        "en": "Good news only today, deal? Tell me one thing that made you smile.",
        "ar": "اليوم أخبار حلوة بس، اتفقنا؟ قول لي شي خلاك تبتسم.",
    },
    "Zephyr": {
        "delivery": "bright and clear, a playful double take",
        "en": "Good morning! Or evening... honestly, whatever time it is, hi!",
        "ar": "صباح الخير! أو مساء الخير... المهم، هلا والله!",
    },
}


def line_for(voice: str, lang: str) -> tuple[str, str]:
    """(delivery, text) for one sample."""
    entry = VOICE_LINES.get(voice, {})
    return entry.get("delivery", DEFAULT_DELIVERY), entry.get(lang, LINES[lang])


def voices() -> list[str]:
    from backend.configs.runtime import voice_runtime_config

    return list(voice_runtime_config()["token"]["allowed_voice_ids"])


def render(client, voice: str, text: str, delivery: str = DEFAULT_DELIVERY) -> bytes:
    from google.genai import types

    result = client.models.generate_content(
        model="gemini-2.5-flash-preview-tts",
        contents=f"Say it {delivery}: {text}",
        config=types.GenerateContentConfig(
            response_modalities=["AUDIO"],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice))
            ),
        ),
    )
    return result.candidates[0].content.parts[0].inline_data.data  # 24 kHz 16-bit mono PCM


async def _render_live(client, model: str, voice: str, text: str, delivery: str) -> tuple[bytes, str]:
    from google.genai import types

    config = types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        system_instruction=(
            "You are a voice actor recording a short sample. Read the user's line exactly as written, "
            f"{delivery}. Say nothing else."
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


def render_live(client, model: str, voice: str, text: str, delivery: str = DEFAULT_DELIVERY) -> bytes:
    pcm, said = asyncio.run(_render_live(client, model, voice, text, delivery))
    if pcm and not said:
        # The live model often skips its transcript (mostly in Arabic): listen with Whisper instead.
        from backend.infra.llm.transcribe import transcribe_audio

        said = transcribe_audio(_wav(pcm), "audio/wav").text
    expected = _words(text)
    if not pcm or len(expected & _words(said)) < 0.6 * len(expected):
        raise ValueError(f"said something else: {said[:80]!r}")
    return pcm


def _wav(pcm: bytes) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(24000)
        out.writeframes(pcm)
    return buffer.getvalue()


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
    parser.add_argument("--only", default="", help="comma-separated voice names (default: all)")
    args = parser.parse_args()

    from google import genai

    from backend.configs.settings import get_settings

    client = genai.Client(api_key=get_settings().resolved_gemini_api_key())
    if args.engine == "live":
        from backend.domain.voice.services.token import live_model_id

        live_client = genai.Client(api_key=get_settings().resolved_gemini_api_key(), http_options={"api_version": "v1alpha"})
        model = live_model_id()
        speak = lambda voice, text, delivery: render_live(live_client, model, voice, text, delivery)  # noqa: E731
    else:
        speak = lambda voice, text, delivery: render(client, voice, text, delivery)  # noqa: E731
    OUT.mkdir(parents=True, exist_ok=True)
    only = {v.strip() for v in args.only.split(",") if v.strip()}
    for voice in voices():
        if only and voice not in only:
            continue
        for lang in LINES:
            delivery, text = line_for(voice, lang)
            target = OUT / f"{voice}-{lang}.mp3"
            if target.exists() and not args.force:
                continue
            for attempt in range(6):
                try:
                    encode(speak(voice, text, delivery), target)
                    print(f"  {target.name} ({target.stat().st_size // 1024} KB)")
                    break
                except Exception as exc:  # rate limits or a wrong take: wait and retry
                    print(f"  {voice}-{lang}: {type(exc).__name__}: {str(exc)[:100]}, retrying", file=sys.stderr)
                    # A wrong take is retried at once; rate limits need a pause.
                    time.sleep(2 if isinstance(exc, ValueError) else 20 * min(attempt + 1, 3))
            time.sleep(2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
