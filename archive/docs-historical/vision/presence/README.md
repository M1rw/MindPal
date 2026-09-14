# MindPal Presence — Research Index

> Research phase for the MindPal Presence feature.
> All files here are living documents — updated as research progresses.

## Research Files

| File | Topic | Status |
|---|---|---|
| [01-yolo-on-device.md](./01-yolo-on-device.md) | On-device YOLO vision pipeline (WASM) | In Progress |
| [02-speaker-diarization.md](./02-speaker-diarization.md) | Real-time multi-speaker separation | In Progress |
| [03-webrtc-architecture.md](./03-webrtc-architecture.md) | Full-duplex WebRTC design | In Progress |
| [04-zero-knowledge-security.md](./04-zero-knowledge-security.md) | E2E encryption + zero-knowledge design | In Progress |
| [05-therapeutic-ai-research.md](./05-therapeutic-ai-research.md) | AI therapy efficacy + ethical framework | In Progress |

## Key Research Questions

1. Can YOLOv9-nano run at >= 15fps in-browser on a mid-range 2022 laptop?
2. What is the minimum viable speaker diarization latency for real-time feel (<500ms)?
3. Is WebCrypto SubtleCrypto sufficient for user-derived key encryption?
4. What does published research say about AI-facilitated couple/group therapy outcomes?
5. How does EU AI Act Article 6 classify a camera-based emotion inference tool?

## Decision Log

| Date | Decision | Rationale |
|---|---|---|
| Sep 2026 | On-device YOLO (not cloud) | Privacy-first; raw video never leaves device |
| Sep 2026 | WebRTC for audio, not raw WebSocket | DTLS-SRTP mandatory encryption; lower latency |
| Sep 2026 | User-derived AES-256-GCM keys | Server-side zero-knowledge; breach-proof |
| Sep 2026 | No raw video/audio retention ever | Regulatory (BIPA, GDPR), ethical, trust |
