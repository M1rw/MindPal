# Voice System V3: Comprehensive Root Cause Analysis & Architecture Guide

## Overview

MindPal Voice System V3 provides a real-time, bi-directional, full-duplex conversational voice experience using the Google Gemini Live API. This document details why Voice System V3 previously experienced failures during development and production deployment, the exact root causes, and how each issue was systematically resolved.

---

## Root Causes & Problems Identified in Voice V3

### 1. Dynamic Asset Path & Bundled Module Import Failures
* **Problem**: In production (Vercel deployment), clicking the Voice button resulted in:
  `Error: Failed to fetch dynamically imported module: https://mindpal.app/voice-v3/assets/runtime.js`
* **Root Cause**:
  Voice V3 was originally configured as a Vite-built ESM module splitting project. Vite emitted a small dynamic entry script (`runtime.js`) that dynamically imported chunks (`chunks/app-xxx.js`). Under Vercel's static asset routing and caching headers, browser dynamic `import()` calls failed or suffered MIME/path resolution mismatches.
* **Resolution**:
  Reconfigured the Vite build pipeline in `scripts/build_voice_v3_for_vercel.sh` to execute a single-pass, self-contained runtime build (`VOICE_V3_RUNTIME_ONLY=1`). This produces a single self-contained ~101KB `runtime.js` without transitive ESM imports. The production facade (`frontend/js/voice_session.js`) injects this runtime as a native `<script type="module">` tag with cache-busting version query keys.

---

### 2. Ephemeral Token WebSocket Endpoint Mismatch
* **Problem**: WebSocket connection closed immediately with error:
  `1008 Method doesn't allow unregistered callers (callers without established identity)`
* **Root Cause**:
  MindPal Backend V2 issues single-use ephemeral tokens via Google Gemini's REST API (`POST /v1beta/auth_tokens`). When connecting over WebSocket with an ephemeral token, connecting to the standard Gemini Live service URL (`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`) fails because that endpoint requires an explicit API key parameter.
* **Resolution**:
  Corrected the backend WebSocket URL generator in `backend/api/voice_router.py` to route ephemeral-token browser clients to the dedicated constrained service path:
  `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=...`

---

### 3. Setup Payload Schema & Parameter Discrepancies
* **Problem**: Session connection opened but timed out after 15 seconds waiting for `setupComplete` (`Gemini setupComplete timeout`).
* **Root Causes**:
  - **`speechConfig` Placement**: The transport originally sent `speechConfig` as a top-level key in the initial WebSocket setup JSON frame. Google Gemini's Live API schema requires `speechConfig` to be nested inside `generationConfig`:
    ```json
    {
      "setup": {
        "model": "models/gemini-2.5-flash-native-audio-preview-12-2025",
        "generationConfig": {
          "responseModalities": ["AUDIO"],
          "speechConfig": {
            "voiceConfig": {
              "prebuiltVoiceConfig": { "voiceName": "Kore" }
            }
          }
        }
      }
    }
    ```
  - **Unsupported Model Parameters**: Injected `thinkingConfig` (or incompatible `thinkingBudget` fields) into Gemini Native Audio models. Gemini Native Audio models reject unknown keys in setup JSON, causing silent setup rejection.
  - **Model Resource Name Consistency**: Ephemeral token creation (`live_connect_constraints`) and WebSocket setup frames require consistent model naming (`models/{model}`).

---

### 4. `setupComplete` JSON Response Deserialization Bug
* **Problem**: Client transport reported timeout even when Gemini sent a successful setup response over the socket.
* **Root Cause**:
  Gemini Live API returns `setupComplete` as an empty object protobuf serialization (`{"setupComplete": {}}` or `{"setupComplete": null}`). The original client parser checked strictly for a boolean (`{"setupComplete": true}`). Because `{}` and `null` did not equal `true`, the transport ignored the acknowledgment frame.
* **Resolution**:
  Updated `ws-manager.ts` and `runtime.js` to inspect key presence rather than boolean truthiness:
  `if ("setupComplete" in message || "setup_complete" in message) { ... }`

---

### 5. Slash Percent-Encoding in Ephemeral `access_token`
* **Problem**: Query string formatting corrupted token values containing resource slashes (e.g., `authTokens/abc123xyz`).
* **Root Cause**:
  Standard `encodeURIComponent` converts `/` into `%2F`. Gemini's token verification gateway failed to parse token IDs when slashes were encoded as `%2F`.
* **Resolution**:
  Updated `buildEphemeralVoiceWebSocketUrl` in frontend startup helpers to preserve slashes while encoding other special query characters:
  `token.replace(/%/g, "%25").replace(/#/g, "%23").replace(/\?/g, "%3F").replace(/&/g, "%26")`

---

### 6. Microphone Access & AudioWorklet Secure Context
* **Problem**: Microphone capture failed in non-HTTPS environments or mobile browsers.
* **Root Cause**:
  `AudioWorklet` (`pcm_capture_worklet.js`) and `navigator.mediaDevices.getUserMedia` are restricted by browser web security standards to Secure Contexts (`https://` or `127.0.0.1`).
* **Resolution**:
  Added explicit HTTPS / localhost checks, user permission prompts with fallback error surfacing in the Voice UI, and static path fallback for `pcm_capture_worklet.js`.

---

## Current Voice V3 Architecture & Flow

```
[Browser Client]
   │
   ├── 1. Request single-use token ────► [FastAPI Backend /api/voice/token]
   │                                           │
   │                                           ├── Generates single-use token via Gemini API
   │                                           └── Returns constrained WebSocket URL
   │
   ├── 2. Direct WebSocket Connect ───► [Gemini Live API (BidiGenerateContentConstrained)]
   │                                           │
   │                                           ├── Client sends setup frame (speechConfig, voiceName)
   │                                           └── Provider responds with {"setupComplete": {}}
   │
   └── 3. Full-Duplex Audio Flow ─────► [PCM Audio Input (16kHz) / PCM Audio Output (24kHz)]
```

---

## Test Verification

Voice V3 includes full test coverage across frontend and backend:
- Backend: `tests/test_voice_security.py`, `tests/test_voice_fallback_resilience.py`, `tests/test_voice_v3_launch_gate.py`, `tests/test_voice_tts_v3.py`.
- Frontend: `tests/test_voice_*.mjs` (16 test files covering transport, setup payload, caption sync, transcript assembly, worklet URLs, recovery policies).
