# MindPal Presence
### Vision · Research · Future Integration

> **Status**: Vision / Research Phase — Not yet scheduled for development.  
> **Classification**: Internal Research · Do not publish.  
> **Idea Origin**: September 2026

---

## What Is MindPal Presence?

MindPal today is a 1:1 text and voice assistant — the user and the AI.  
**MindPal Presence** breaks that boundary.

It is a **multi-person, full-duplex, camera-aware AI therapy and counseling mode** where MindPal becomes the therapist in the room — seeing, hearing, and understanding every person present, in real-time, without requiring any typing or rigid UI interaction.

One friend. Two partners. A family. A group. It doesn't matter. MindPal Presence meets them where they are.

---

## The Problem It Solves

Traditional therapy has three massive barriers:
1. **Cost** — $150–$300/session, rarely covered by insurance
2. **Access** — weeks-long waitlists, geography, language
3. **Stigma** — walking into an office, making a call, admitting you need help

Digital mental health apps solved access partially — but they're all still **text-and-chat**, one person, one session. None of them can see the couple sitting on the couch. None of them can hear the trembling in a voice. None of them can notice one person shutting down while the other escalates.

MindPal Presence does.

---

## The Experience

### Session Modes (User-Selectable or AI-Inferred)

| Mode | Who | What MindPal Does |
|---|---|---|
| **Solo Presence** | 1 person | Voice + camera for richer context (body language, visible distress signals) |
| **Couples Session** | 2 people | Balanced mediation, tracks each person's tone + engagement separately |
| **Friends / Peer Support** | 2–4 people | Facilitates structured dialogue, identifies who needs space to speak |
| **Family Dynamics** | 3–6 people | Tracks relationships, redirects unhealthy loops, builds on family memory |
| **Group Reflection** | Up to 8 people | Community/support-group format, rotating focus, AI keeps balance |

MindPal asks: *"What brings everyone here today?"* — then **builds the session structure dynamically**. No forms. No pre-selection required. Just speak.

---

## Technical Architecture

### Layer 1 — On-Device Vision (YOLO Pipeline)

The camera feed **never leaves the device raw**. All vision processing happens locally using a quantized YOLO model (YOLOv9/v10 or successor) running in-browser via WebAssembly (WASM) or a native companion sidecar.

**What YOLO tracks per frame:**
- Person bounding boxes → identity persistence across frames (who is Person A, B, C)
- Face landmark detection → approximate gaze direction, eye contact, eye closure
- Pose estimation → body orientation (leaning in, crossed arms, turned away)
- Proximity between individuals → physical closeness/distance as relational signal
- Micro-expression windows (cropped face region) → sent to on-device lightweight emotion classifier

**What is NOT sent to cloud:**
- Raw video frames
- Face crops
- Biometric data

**What IS sent to cloud (encrypted):**
- Derived signal vectors: `{ person_id: "A", gaze_score: 0.3, posture: "closed", emotion_estimate: "withdrawn", speaking: false, timestamp: 1234567890 }`
- These are semantically rich but never re-identifiable from raw data

### Layer 2 — Full-Duplex Voice Pipeline

Built on WebRTC data channels with server-side speaker diarization.

- Each person's audio is separated server-side (voice diarization → who is speaking)
- Real-time speech-to-text per speaker
- Prosodic feature extraction per utterance: pitch variance, speech rate, volume envelope → maps to `{ tone: "escalating" | "flat" | "distressed" | "calm" }`
- **Voice tone + YOLO emotion estimate are fused** → richer per-person state signal

### Layer 3 — MindPal Presence Brain (LLM Orchestration)

A specialized orchestration layer that:

1. Maintains a **per-person state object** updated every ~2 seconds from the vision+voice pipeline
2. Maintains a **relationship graph** between all detected persons (who is addressing whom, who is being ignored)
3. Runs a **session director** — decides when to speak, who to address, what tone to take
4. Chooses one of multiple **intervention modes**:
   - `listen` — stay silent, let it play out
   - `reflect` — mirror back what was said to the speaker
   - `mediate` — address tension between two people
   - `redirect` — pull focus from a derailing topic
   - `ground` — calm a rising emotional state with breathing/pacing prompts
   - `check-in` — notice silent/withdrawn person and gently invite them
5. Generates voice output (TTS, same voice channel) addressed by first name

**No user input required.** The session runs like a real therapy session.

---

## Session Lifecycle

```
User grants camera + mic access
│
├── YOLO initializes (on-device, < 2s cold start)
│   └── Detects persons in frame
│
├── MindPal introduces itself:
│   "I can see there are two of you. Before we begin, could you each tell me your name?"
│
├── Voice diarization maps names → Person A, Person B (locally stored, session-scoped)
│
├── MindPal asks: "What brings you both here today?"
│   (or infers from memory if prior sessions exist)
│
├── Session Director activates: continuous loop
│   ├── Fuse vision + voice signals (every 2s)
│   ├── Update per-person state + relationship graph
│   ├── Evaluate: should I intervene? what mode?
│   └── Speak / stay silent based on session director decision
│
└── Session ends when:
    - User says "thank you" / "we're done" / closes window
    - Session exceeds configured max duration
    - MindPal detects session has naturally concluded (silence + low tension)
    │
    └── MindPal delivers closing reflection, saves session summary to memory
        (text summary only, no video/audio retained)
```

---

## Modes Deep Dive

### Couples Counseling Mode

The gold standard use case. Two people, seated, in conflict or seeking growth.

MindPal tracks:
- **Turn imbalance**: Who speaks 70%+ of the time → redirect
- **Escalation spirals**: Both tone scores rising → interrupt and ground
- **Stonewalling detection**: One person's gaze avoidance + silence > 45s → check-in
- **Physical withdrawal**: Person turns body away → gently name it and invite reengagement
- **Progress moments**: Both lean in, tone calms, eye contact increases → reinforce

Session has three phases:
1. **Open** — each person shares their perspective uninterrupted
2. **Dialogue** — facilitated exchange with MindPal mediating
3. **Close** — shared reflection and one actionable intention for each person

### Solo Presence Mode

For the user who wants more than text. Camera adds:
- Visible anxiety signals (rapid movement, facial tension)
- Flat affect detection (depression marker)
- Physical grounding prompts when distress is high (e.g., "I notice your breathing seems fast — let's slow down together for a moment")

This mode is the gateway. Most users will try this before inviting others.

### Group Reflection Mode

Up to 8 people. Think: support group, friend group after a shared trauma, a team after a hard event.

MindPal tracks a **speaking equity score** across all members. No one is silenced. No one dominates. MindPal facilitates like a skilled group moderator.

---

## The Navigation Concept (Future UI)

The tab bar **lives on the home screen from the very first moment the user opens MindPal** — not hidden inside a sidebar or revealed after an action. This is the user's launchpad.

### Home Screen (Default — No Active Session)

```
┌─────────────────────────────────────────────────────────────┐
│                                                      ⚙️  👤  │
│                                                             │
│   ╔══════════════════════════════════════╗                  │
│   ║  💬 Chat          👁 Presence        ║  ← always here   │
│   ╚══════════════════════════════════════╝                  │
│                     ↑ active tab underline indicator        │
│                                                             │
│           Hello, Miljte.                                    │
│      What's on your mind today?                             │
│                                                             │
│   [I feel overwhelmed]  [I'm feeling anxious]  [I feel stuck]│
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │  Ask MindPal...                         Standard ▾  │   │
│   └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

### Clicking "Chat" → Chat Workspace

Clicking **Chat** slides/fades into a workspace view. MindPal has one default chat — **"My Chat"** — always present. The user can also create additional named chats (like Claude's Projects or Notion pages).

```
┌─────────────────────────────────────────────────────────────┐
│                                                      ⚙️  👤  │
│   ╔══════════════════════════════════════╗                  │
│   ║  💬 Chat ●        👁 Presence        ║                  │
│   ╚══════════════════════════════════════╝                  │
│  ┌──────────────┬──────────────────────────────────────┐    │
│  │ 💬 My Chat ← │                                      │    │
│  │              │   [conversation stream]               │    │
│  │ + New Chat   │                                      │    │
│  │              │   ┌──────────────────────────────┐   │    │
│  │  Work ↗      │   │  Ask MindPal...    Standard ▾│   │    │
│  │  Relationship│   └──────────────────────────────┘   │    │
│  └──────────────┴──────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

- **"My Chat"** is the default, personal 1:1 session — always first in the list
- **"+ New Chat"** creates a named workspace with its own isolated context and memory scope
- Switching between chats is instant — the right panel cross-fades content
- The sidebar can be collapsed on mobile (tap the chat name to toggle)

---

### Clicking "Presence" → Presence Entry Flow

Clicking **Presence** triggers a smooth full-panel transition — the entire canvas slides or dissolves into the Presence entry screen. No abrupt jump.

```
Transition: current screen fades out (opacity 0, scale 0.98) over 220ms
            Presence entry screen fades in (opacity 1, scale 1) over 220ms
            Active tab indicator slides smoothly to "Presence"
```

Presence entry screen:

```
┌─────────────────────────────────────────────────────────────┐
│   ╔══════════════════════════════════════╗                  │
│   ║  💬 Chat          👁 Presence ●      ║                  │
│   ╚══════════════════════════════════════╝                  │
│                                                             │
│              👁  MindPal Presence                           │
│         A safe space — for one or many.                     │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │  🎙  Solo Session       Just me, voice + camera     │   │
│   │  💑  Couples Session    Two people, guided dialogue  │   │
│   │  👥  Group Session      3–8 people, open circle     │   │
│   └─────────────────────────────────────────────────────┘   │
│                                                             │
│              [ Begin Session → ]                            │
│                                                             │
│   🔒 Camera stays on your device. Nothing is recorded.     │
└─────────────────────────────────────────────────────────────┘
```

Each mode card animates in sequentially (stagger: 60ms per card) for a polished, alive feel.

---

### Transition Principles (Tier-1 Standard)

| Transition | Duration | Easing | Notes |
|---|---|---|---|
| Tab switch (home → chat) | 220ms | `cubic-bezier(0.4, 0, 0.2, 1)` | Fade + subtle scale |
| Tab switch (home → presence) | 250ms | `cubic-bezier(0.4, 0, 0.2, 1)` | Fade + scale + bg tint shift |
| Tab indicator slide | 180ms | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Spring-like overshoot |
| Chat list item select | 150ms | ease-out | Cross-fade right panel |
| Presence mode card hover | 100ms | ease | Lift + border highlight |
| Presence mode card stagger | 60ms delay each | ease-out | Cards animate in sequence |
| Session start → camera view | 350ms | ease-in-out | Full canvas dissolve |

No hard cuts. Every state change is communicated through motion.

---

### Future Tab Additions

The tab bar is extensible. Future modes slot in naturally:

- **📓 Journal** — voice-to-text reflective journaling with AI response
- **🧠 Insights** — longitudinal progress, memory graph visualization  
- **👥 Circle** — trusted person notifications (opt-in, for crisis safety planning)

---

## Security Architecture

> This is where MindPal Presence must be the most carefully engineered part of the entire system.  
> A camera-enabled AI therapy tool that sees people's faces and hears their most vulnerable moments  
> carries a responsibility that exceeds any previous consumer AI product.

### Principle: Radical Data Minimization

**We collect the minimum signal necessary to provide value. Nothing more.**

| What we process | Where | Retained? |
|---|---|---|
| Raw video frames | On-device only | **Never** |
| Face crops / biometrics | On-device only | **Never** |
| Audio waveforms | In-transit (encrypted), transient server buffer | **Never** (discarded after diarization) |
| Derived signal vectors (posture, tone category) | Server, in-memory only during session | **Never** persisted |
| Transcribed speech text | Server, encrypted | Session summary only (user-controlled) |
| Session summary (text) | Encrypted at rest, user-owned | User-deletable at any time |

### Encryption Stack

**Transport**: TLS 1.3 minimum, HSTS enforced. WebRTC peer connections use DTLS-SRTP (mandatory, no fallback).

**At Rest**: AES-256-GCM for all session summaries. Encryption keys are **user-derived** using a KDF seeded from the user's auth token — the server holds ciphertext but **never the plaintext key**. Even a full server compromise yields nothing readable.

**Signal Vectors**: The derived per-person signal vectors (posture, tone, gaze) are:
- Ephemeral — never written to disk, only held in process memory during session
- Tagged with the session ID but not user ID (unlinkable after session ends)
- Purged from memory within 60 seconds of session close

### On-Device YOLO — The Privacy Firewall

The YOLO model runs entirely in the browser via WebAssembly. The architecture:

```
Camera → MediaStream API → On-device YOLO (WASM) → Signal vectors only → Encrypted WebSocket → Server
         [raw frames never leave this boundary]
```

We use a **permissioned WebWorker** for the YOLO pipeline. The main thread never has access to raw frame data. The worker only emits structured signal objects.

This is architecturally equivalent to how Apple's Face ID processes biometrics — the raw data never crosses a trust boundary.

### Consent and Transparency

Every Presence session begins with an explicit, plain-language consent screen:
- What the camera sees (detected body positions, estimated emotion)
- What is never stored (raw video, face data)
- What is stored (text summary of conversation)
- How to delete everything
- Who can see the session (only the account owner, no therapist, no MindPal staff)

Consent is **per-session** for the first 5 sessions, then per-major-version-update.

### Regulatory Alignment

| Regulation | How MindPal Presence complies |
|---|---|
| **GDPR (EU)** | Data minimization, right to erasure, explicit consent, no biometric storage |
| **HIPAA (US)** | Session text treated as PHI, encrypted, access-logged, BAA-ready architecture |
| **CCPA (California)** | No sale of data, right to delete, transparent collection notice |
| **Illinois BIPA** | On-device only biometric processing, no retention, consent-gated |
| **AI Act (EU, 2025)** | High-risk AI category — conformity assessment, human oversight design, incident logging |

### Threat Model

| Threat | Mitigation |
|---|---|
| Server breach / data exfil | User-derived encryption keys — server holds no plaintext |
| MITM on video stream | DTLS-SRTP mandatory on WebRTC, TLS 1.3 on signaling |
| Model extraction / adversarial inputs | YOLO runs on-device; server never sees frames |
| Session replay | Session tokens are single-use, signed with user key |
| Insider threat (MindPal employee) | Zero-knowledge architecture: employees cannot read session content |
| Account takeover → session history access | Sessions encrypted with keys derived from auth credential; rotating keys on re-auth |
| CSAM / harmful content in camera | On-device NSFW classifier runs before YOLO; session terminates and flags if triggered |

### The Zero-Knowledge Trust Architecture

MindPal Presence operates on a **zero-trust, zero-knowledge architecture** for session content:

1. The user's device is the **trust anchor**
2. The server is a **signal relay and orchestration layer** — it sees encrypted signals, not content
3. MindPal staff have **no technical capability** to access session recordings or face data — this is enforced architecturally, not just by policy

This mirrors how Signal handles end-to-end encrypted messaging — but extended to multimodal therapy data. Server-side key rotation, user-controlled data deletion, and auditable access logs make this independently verifiable.

---

## Research Areas to Explore Before Building

- [ ] **WebAssembly YOLO benchmarks** — YOLOv9-nano WASM throughput on mid-range devices (target: 15fps minimum at 480p)
- [ ] **Speaker diarization accuracy** at 2–4 speakers with overlapping speech (pyannote.audio evaluation)
- [ ] **Emotion estimation validity** — literature review: can lightweight models provide clinically useful signals or are they too noisy to be therapeutic?
- [ ] **Therapeutic alliance via AI** — does AI-mediated session feel real enough to produce outcomes? (research on chatbot-based CBT efficacy)
- [ ] **Multi-jurisdictional legal review** — especially BIPA (biometric data), AI Act (high-risk AI), and HIPAA BAA contractual path
- [ ] **Ethical framework** — when should MindPal refer to human professionals? How does it handle crisis escalation in a group setting?
- [ ] **Adversarial robustness** — can emotion/posture signals be gamed? Does it matter therapeutically?
- [ ] **On-device LLM viability** — can a 7B quantized model run the Session Director locally? (latency + quality evaluation)

---

## Why This Matters

No product does this. Not BetterHelp. Not Woebot. Not Replika. Not any AI companion today.

The closest thing is a Zoom therapy session with a human. We are building the next step beyond that — available to anyone, at any time, in any language, with no waitlist, at a fraction of the cost.

Done right, with radical transparency and privacy-first engineering, MindPal Presence could be one of the most impactful mental health tools ever built.

Done wrong, it becomes a surveillance product. The difference is entirely in the architecture and the values embedded in every technical decision.

**We build it right, or we don't build it.**

---

*Last updated: September 2026 | Author: MindPal Research*
