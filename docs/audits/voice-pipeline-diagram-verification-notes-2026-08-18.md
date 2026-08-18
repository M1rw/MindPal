# Voice pipeline diagram verification notes

The current-state control-flow diagram rendered successfully at 3120 x 6388 pixels. Its main vertical path is readable from the UI start through backend token issuance, WebSocket setup, capture/VAD, server events, evidence/tools, playback, interruption, recovery, and post-call cleanup. The end-of-call branch is visually separated at the top because Mermaid auto-layout places it away from the main path; the written report must therefore explain that it is a terminal branch, not a separate startup path.

The sequence diagram rendered successfully at 3120 x 4456 pixels. It clearly shows the primary actors: user, `voice_live.js`, `voice/runtime.js`, FastAPI `voice_router.py`, Gemini Live WebSocket, `/api/tools/execute`, `/api/voice/verify-current-fact`, and post-call persistence. The loop for microphone frames, alternate local-time/current-fact/normal conversation branches, tool branches, fact-gate playback, interruption/turn completion, recovery, and incognito persistence are readable. The four weak-boundary notes are visible at the bottom:

1. Internal text notices share `realtimeInput` with user audio.
2. Verification starts from input-transcription chunks rather than an explicit finalized `TurnContext`.
3. The tool executor contains backend execution and browser fallback in one module.
4. One mutable runtime owns capture, transport, turns, tools, playback, recovery, and teardown.

The diagrams are suitable for delivery as supporting artifacts. The control-flow diagram is best for architecture and failure branches; the sequence diagram is best for explaining the chronological request/response pipeline.
