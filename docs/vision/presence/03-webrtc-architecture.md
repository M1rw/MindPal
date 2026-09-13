# 03 — WebRTC Full-Duplex Architecture

## Goal
Establish a secure, low-latency, full-duplex audio/video channel between
the user device and the MindPal Presence backend. Video frames never leave
the device. Only derived signal vectors and audio reach the server.

---

## Architecture Overview

```
USER DEVICE                          MINDPAL SERVER
-----------                          --------------
Camera -> YOLO Worker                Signaling Server (FastAPI WS)
       -> SignalVectors --WSS-------> Session Director (LLM)
                                              |
Mic -> WebRTC AudioTrack --DTLS-SRTP-> Diarization Service
                                       STT + Prosodics
                                              |
                         <-- TTS Audio -------+
Speaker <- WebRTC AudioTrack
```

Key principle: **Video track is never sent to the server.**
The WebRTC PeerConnection is audio-only. The YOLO Worker on the device
processes video locally and sends only JSON signal vectors over a separate
encrypted WebSocket.

---

## Connection Setup

### Signaling Flow
```
1. Client opens WSS /api/presence/signal
2. Server creates RTCPeerConnection offer
3. Client answers with SDP + ICE candidates
4. DTLS handshake completes -> encrypted audio channel active
5. Client opens secondary WSS /api/presence/signals -> sends YOLO vectors
6. Session begins
```

### ICE / STUN / TURN
- Primary: Google STUN (stun.l.google.com:19302) for NAT traversal
- Fallback: Self-hosted TURN server (coturn) for restrictive NAT environments
- TURN credentials: short-lived HMAC tokens (rotate every 5 minutes)

---

## Audio Track Design

### Client -> Server (User speech)
- Codec: Opus 48kHz, 64kbps (optimal for voice clarity + bandwidth)
- Packet loss concealment: enabled (Opus native)
- Echo cancellation: browser WebRTC AEC (automatic)
- Noise suppression: browser WebRTC NS (automatic)

### Server -> Client (MindPal TTS voice)
- Codec: Opus 48kHz, 32kbps (TTS is cleaner, needs less bitrate)
- TTS engine: ElevenLabs (warmest) or Google TTS Neural2 (faster, cheaper)
- Streaming TTS: chunks pushed as audio frames as soon as first sentence ready
- Interruption handling: client can interrupt MindPal mid-speech (VAD detection)

---

## Signal Vector WebSocket

Separate from the audio WebRTC channel. Sends YOLO output every 2 seconds.

```typescript
// Signal vector schema
interface PresenceSignal {
  session_id: string;        // ephemeral, not linked to user_id
  frame_ts: number;          // unix ms
  persons: PersonSignal[];
}

interface PersonSignal {
  person_id: string;         // "A" | "B" | "C" ... (session-scoped only)
  speaker_id: string | null; // mapped from diarization, null if unknown
  posture: "open" | "closed" | "withdrawn" | "leaning_in";
  gaze: "partner" | "screen" | "away" | "down";
  gaze_score: number;        // 0.0 (fully away) - 1.0 (direct eye contact)
  emotion_estimate: "calm" | "distressed" | "escalating" | "flat";
  emotion_confidence: number;
  speaking: boolean;
  bbox_normalized: [number, number, number, number]; // never sent in production
}
```

Note: `bbox_normalized` is stripped server-side on receive. It exists only
for local debugging and is never logged.

---

## Security on the Wire

| Channel | Protocol | Encryption |
|---|---|---|
| Signaling | WSS (TLS 1.3) | TLS |
| Audio (user) | WebRTC | DTLS 1.3 + SRTP AES-128 |
| Audio (MindPal TTS) | WebRTC | DTLS 1.3 + SRTP AES-128 |
| Signal vectors | WSS (TLS 1.3) | TLS + session token |

DTLS-SRTP is mandatory. If the browser negotiates a non-SRTP connection,
the server drops it immediately (no fallback to unencrypted).

---

## Open Items
- [ ] Evaluate coturn vs Cloudflare TURN for reliability + cost at scale
- [ ] Test Opus packet loss handling at 5% PLR (common on mobile)
- [ ] Implement VAD (Voice Activity Detection) client-side to detect interruptions
- [ ] Design graceful reconnect (30s timeout -> offer re-negotiation)
- [ ] Load test: 100 concurrent Presence sessions on single server node
