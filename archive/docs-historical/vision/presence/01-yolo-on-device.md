# 01 — On-Device YOLO Vision Pipeline

## Goal
Run real-time person detection, pose estimation, and emotion signal extraction
entirely on the user device. No raw frames ever reach the server.

---

## Model Options (2024-2026)

| Model | Size | mAP | WASM viable? | Notes |
|---|---|---|---|---|
| YOLOv9-nano | ~4MB | 46.8 | YES | Best size/accuracy tradeoff for browser |
| YOLOv10-nano | ~5MB | 47.6 | YES | Slightly better, NMS-free |
| YOLOv8-nano | ~3.5MB | 45.2 | YES | Widest ecosystem support |
| RT-DETR-nano | ~6MB | 48.1 | MAYBE | Transformer-based, higher WASM overhead |

**Recommendation**: YOLOv10-nano via ONNX Runtime Web (WASM backend).
Falls back to YOLOv8-nano if ONNX Runtime WebGPU not available.

---

## Runtime: ONNX Runtime Web

ONNX Runtime Web (ort-web) supports:
- WASM backend: universal, ~15fps on mid-range hardware at 480p
- WebGPU backend: ~30fps on supported GPUs (Chrome 113+, Edge)
- WebGL backend: fallback, ~20fps

```
npm install onnxruntime-web
```

Model export pipeline:
```
PyTorch YOLOv10-nano -> torch.onnx.export() -> onnxslim (optimize) -> quantize INT8 -> .onnx
```
Target model size after quantization: ~2.5MB (INT8).

---

## WebWorker Architecture (Privacy Firewall)

```
Main Thread                    Worker Thread (YOLO Worker)
    |                               |
    | --- start(stream) ----------> |
    |                               | MediaStream.getVideoTracks()
    |                               | ImageCapture API (15fps capture)
    |                               | ONNX Runtime inference
    |                               | Extract: boxes, keypoints, crops
    |                               | On-device emotion classifier (MobileNetV3-nano)
    | <-- SignalVector[] ---------- |
    |   { person_id, posture,       |
    |     gaze_score, emotion,      |
    |     speaking, timestamp }     |
```

The Worker has access to the MediaStream. The main thread only ever receives
structured SignalVector objects — never pixel data.

---

## What We Detect Per Frame

### Person Detection + Tracking
- Bounding boxes for each person
- Persistent ID assignment across frames using IoU-based tracker
- Up to 8 simultaneous persons (Group mode max)

### Pose Estimation (17 COCO keypoints)
Derived signals:
- **Body orientation**: angle of shoulder-to-shoulder line vs camera plane
- **Lean direction**: torso keypoint vector (leaning in = engaged, leaning away = withdrawn)
- **Arm crossing**: wrist-to-elbow angle relative to torso (closed body language)
- **Head tilt**: ear-to-nose landmark ratio

### Gaze Estimation (face landmark model, separate 500KB model)
- Eye landmark detection -> gaze direction vector
- Gaze target: self (looking at screen), partner, away
- Eye closure frequency -> drowsiness / flat affect signal

### Emotion Signal (MobileNetV3-nano, face crop)
NOT used as clinical diagnosis — used as a soft signal for session pacing.
7-class output: neutral, happy, sad, angry, fearful, disgusted, surprised
Mapped to 3 therapy-relevant states: calm, distressed, escalating

---

## Performance Benchmarks (Targets)

| Device class | Resolution | Target FPS | Current estimate |
|---|---|---|---|
| High-end (M2 Mac, RTX laptop) | 720p | 30fps | Achievable with WebGPU |
| Mid-range (2021-2023 laptop) | 480p | 15fps | Achievable with WASM |
| Low-end (older mobile) | 360p | 8fps | Minimum viable |

Below 8fps: disable pose/emotion, keep person detection only. Degrade gracefully.

---

## Open Items
- [ ] Benchmark ort-web WASM on Windows Chrome (mid-range AMD CPU)
- [ ] Test multi-person tracking stability when people move/overlap
- [ ] Validate emotion classifier against clinical-adjacent labelled dataset
- [ ] Measure battery drain on mobile at sustained 15fps inference
