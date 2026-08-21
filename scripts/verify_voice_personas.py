from __future__ import annotations

import argparse
import base64
import json
import sys
import urllib.error
import urllib.request
import wave
from pathlib import Path

PERSONAS = ("Kore", "Charon")
CASES = (("mhm", "neutral"), ("okay", "calm"), ("yeah", "excited"), ("aha", "attentive"))


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate review samples for MindPal Gemini persona voice mappings.")
    parser.add_argument("--base-url", required=True, help="MindPal backend origin, for example https://mindpal.example.com")
    parser.add_argument("--token", required=True, help="Firebase ID token; never written to output")
    parser.add_argument("--app-check", default="", help="Optional Firebase App Check token")
    parser.add_argument("--output-dir", type=Path, default=Path("voice-persona-samples"))
    parser.add_argument("--personas", nargs="*", default=list(PERSONAS))
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)
    endpoint = args.base_url.rstrip("/") + "/api/voice/v3/tts"
    manifest: list[dict[str, object]] = []
    for persona in args.personas:
        for cue, emotion in CASES:
            payload = {"text": cue, "persona": persona, "emotion": emotion, "format": "pcm16", "sampleRate": 24_000}
            request = urllib.request.Request(
                endpoint,
                data=json.dumps(payload).encode("utf-8"),
                headers={
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {args.token}",
                    **({"X-Firebase-AppCheck": args.app_check} if args.app_check else {}),
                },
                method="POST",
            )
            try:
                with urllib.request.urlopen(request, timeout=20) as response:
                    result = json.loads(response.read().decode("utf-8"))
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
                print(f"verification failed for {persona}/{cue}: {exc}", file=sys.stderr)
                return 1

            audio_base64 = result.get("audioBase64", "")
            if not isinstance(audio_base64, str) or not audio_base64:
                manifest.append({"persona": persona, "cue": cue, "emotion": emotion, "fallback": result.get("fallback", "unknown")})
                continue
            audio = base64.b64decode(audio_base64, validate=True)
            if len(audio) == 0 or len(audio) % 2 != 0:
                print(f"invalid PCM16 response for {persona}/{cue}", file=sys.stderr)
                return 1
            output_path = args.output_dir / f"{persona.lower()}-{cue}-{emotion}.wav"
            with wave.open(str(output_path), "wb") as wav_file:
                wav_file.setnchannels(1)
                wav_file.setsampwidth(2)
                wav_file.setframerate(24_000)
                wav_file.writeframes(audio)
            manifest.append({
                "persona": persona,
                "cue": cue,
                "emotion": emotion,
                "path": str(output_path),
                "durationMs": result.get("durationMs"),
                "cached": result.get("cached", False),
                "voiceId": result.get("voiceId"),
            })

    (args.output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"saved {len(manifest)} persona verification results to {args.output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
