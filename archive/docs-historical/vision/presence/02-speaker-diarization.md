# 02 — Real-Time Speaker Diarization

## Goal
Separate audio streams by speaker in real-time, map each speaker to a
detected person from the YOLO pipeline, and feed per-speaker transcripts
to the LLM Session Director.

---

## The Problem

Standard speech-to-text (Whisper, Deepgram, etc.) produces one transcript for
all audio. We need to know WHO said WHAT to run couples/group therapy.

Speaker diarization = "who spoke when" segmentation.

---

## Approaches Evaluated

### Option A: Server-Side Diarization (Recommended for V1)
- Audio WebRTC track -> server -> pyannote.audio 3.x pipeline
- Latency: ~300-500ms per segment (acceptable for therapy pacing)
- Accuracy: SOTA diarization error rate (DER) ~8% on 2-speaker, ~14% on 4-speaker
- Privacy: Audio is encrypted in transit (DTLS-SRTP), discarded after diarization

```python
# pyannote.audio 3.x (server-side)
from pyannote.audio import Pipeline
pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1")
# Streams: chunked 2s windows with 500ms overlap for continuity
```

### Option B: Client-Side WebRTC Track Separation
If participants are on separate devices (future multi-device mode):
- Each device sends its own audio track
- Server receives N separate tracks -> N speakers automatically separated
- Zero diarization needed, perfect accuracy
- This is the architecture used by Zoom, Google Meet

### Option C: On-Device Diarization (Future)
- SpeakerNet or TitaNet-small (NVIDIA NeMo) ~8MB ONNX
- WASM viable but latency is ~800ms at speaker boundaries
- Good for offline/private mode with no server

**V1 plan**: Option A (server-side pyannote) for single-device sessions.
**V2 plan**: Option B for multi-device sessions (couples on separate phones).

---

## Prosodic Feature Extraction

Beyond WHO is speaking, we extract HOW they are speaking.

Per utterance (after diarization):
```
{
  speaker_id: "A",
  transcript: "I just don't feel heard at all",
  duration_ms: 2300,
  avg_pitch_hz: 185,          // F0 mean
  pitch_variance: 42,         // emotional variability
  speech_rate_wpm: 148,       // fast = agitated
  volume_db: -12,             // louder = escalating
  pause_before_ms: 800,       // long pause before = hesitation
  tone_class: "distressed"    // derived: calm | distressed | escalating | flat
}
```

Tone classification model: lightweight 4-class SVM trained on IEMOCAP + MSP-IMPROV datasets.

---

## Speaker-to-Person Mapping

Combining voice diarization + YOLO tracking:

1. At session start, YOLO identifies N persons by position (A=left, B=right, etc.)
2. User says their name -> voice diarization assigns speaker ID to that voice
3. System maps: YOLO Person "A" = Speaker "Alex", YOLO Person "B" = Speaker "Sam"
4. This mapping persists for the session (re-verified every 60s via voice fingerprint)

---

## Latency Budget

```
Audio captured (WebRTC)          0ms
DTLS-SRTP encrypt                +5ms
Network transit                  +20-50ms (local broadband)
Server receive + buffer 2s chunk +2000ms
Pyannote diarize 2s chunk        +200ms
STT (Whisper-small server-side)  +150ms
Prosodic feature extract         +30ms
Send result to LLM Director      +10ms
-------------------------------------------
Total round-trip: ~2.4s from utterance start to LLM context update
```

This is acceptable for therapy (human therapists pause 2-4s before responding).

---

## Open Items
- [ ] Evaluate Deepgram Nova-2 with speaker labels as hosted alternative to pyannote
- [ ] Test pyannote 3.1 DER on overlapping speech (two people talking at once)
- [ ] Benchmark Whisper-small vs Whisper-tiny for STT latency on GPU vs CPU
- [ ] Design speaker re-identification after room re-entry (person leaves + comes back)
