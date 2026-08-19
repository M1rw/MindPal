from __future__ import annotations

import math
import random
import wave
from pathlib import Path

SAMPLE_RATE = 16_000
OUT_DIR = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "voice_synthetic"


def voiced(duration_s: float, amplitude: float = 0.08, seed: int = 1) -> list[float]:
    rng = random.Random(seed)
    total = int(duration_s * SAMPLE_RATE)
    output: list[float] = []
    phase = 0.0
    for index in range(total):
        t = index / SAMPLE_RATE
        envelope = 0.7 + 0.3 * math.sin(2 * math.pi * 2.1 * t) ** 2
        carrier = (
            math.sin(2 * math.pi * 145 * t + phase)
            + 0.45 * math.sin(2 * math.pi * 290 * t)
            + 0.20 * math.sin(2 * math.pi * 435 * t)
        ) / 1.65
        breath = (rng.random() * 2 - 1) * 0.008
        output.append(amplitude * envelope * carrier + breath)
        phase += 0.00005
    return output


def noise(duration_s: float, amplitude: float = 0.003, seed: int = 2) -> list[float]:
    rng = random.Random(seed)
    return [(rng.random() * 2 - 1) * amplitude for _ in range(int(duration_s * SAMPLE_RATE))]


def silence(duration_s: float) -> list[float]:
    return [0.0] * int(duration_s * SAMPLE_RATE)


def concat(*parts: list[float]) -> list[float]:
    output: list[float] = []
    for part in parts:
        output.extend(part)
    return output


def write_wav(path: Path, samples: list[float]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = bytearray()
    for sample in samples:
        value = max(-1.0, min(1.0, sample))
        pcm.extend(int(round(value * 32767)).to_bytes(2, "little", signed=True))
    with wave.open(str(path), "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(SAMPLE_RATE)
        stream.writeframes(bytes(pcm))


def main() -> None:
    # Continuous story-like speech with short natural pauses. This is a signal
    # fixture, not intelligible language, and is used only for timing/VAD tests.
    write_wav(
        OUT_DIR / "long_story.wav",
        concat(
            silence(0.50),
            voiced(3.0, seed=10), silence(0.35),
            voiced(3.2, seed=11), silence(0.45),
            voiced(3.4, seed=12), silence(0.30),
            voiced(2.8, seed=13), silence(0.60),
        ),
    )

    # A speech segment interrupted by a distinct second segment after a brief
    # gap, used to verify local ducking/release transitions.
    write_wav(
        OUT_DIR / "sudden_interruption.wav",
        concat(voiced(1.20, seed=20), silence(0.12), voiced(0.70, amplitude=0.12, seed=21), silence(0.40)),
    )

    # Low-level keyboard/fan-like noise with a speech segment in the middle.
    write_wav(
        OUT_DIR / "background_noise.wav",
        concat(noise(1.50), voiced(1.20, amplitude=0.07, seed=30), noise(1.50, amplitude=0.004, seed=31)),
    )


if __name__ == "__main__":
    main()
